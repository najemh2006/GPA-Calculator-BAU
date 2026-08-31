    'use strict';

    const UNDO_TIMEOUT_MS = 5000;
    const SAVE_INDICATOR_REFRESH_MS = 10000;
    const CALC_DEBOUNCE_MS = 150;
    const STORAGE_KEY = 'bau_gpa_calculator_data';
    const GRADE_MIN = 0;
    const GRADE_MAX = 4;
    const MAX_HOURS = 256;
    const MIN_PLAN_HOURS = 132;

    const AppState = {
        chartInstance: null,
        hasCelebrated: false,
        isWarningState: false,
        confettiPromise: null,
        deletedCourseState: null,
        undoToastTimeout: null,
        undoInterval: null,
        lastSaveTime: null,
        timeUpdateInterval: null,
        lastChartDataString: "",
        currentTimestamp: null,
        animFrames: new WeakMap() // يمنع تراكب أكثر من حركة على نفس العنصر
    };

    const DOM = {};

    function cacheDOM() {
        DOM.gpaRating = document.getElementById('gpaRating');
        DOM.oldGpa = document.getElementById('oldGpa');
        DOM.oldHours = document.getElementById('oldHours');
        DOM.planTotal = document.getElementById('planTotal');
        DOM.planTarget = document.getElementById('planTarget');
        DOM.hist1 = document.getElementById('hist1');
        DOM.hist2 = document.getElementById('hist2');
        DOM.coursesContainer = document.getElementById('coursesContainer');
        DOM.resultGpa = document.getElementById('resultGpa');
        DOM.semesterGpaBadge = document.getElementById('semesterGpaBadge');
        DOM.resultHours = document.getElementById('resultHours');
        DOM.semesterHoursBadge = document.getElementById('semesterHoursBadge');
        DOM.appContainer = document.getElementById('appContainer');
        DOM.progressWrapper = document.getElementById('progressWrapper');
        DOM.progressPercent = document.getElementById('progressPercent');
        DOM.progressFill = document.getElementById('progressFill');
        DOM.progressNote = document.getElementById('progressNote');
        DOM.undoToast = document.getElementById('undoToast');
        DOM.saveStatusText = document.getElementById('saveStatusText');
        DOM.undoTimerText = document.getElementById('undoTimerText');
        DOM.circlePath = document.getElementById('circlePath');
    }

    function debounce(func, delay) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => { func.apply(this, args); }, delay);
        };
    }

    const debouncedCalculateAndSave = debounce(() => { calculateGPA(true); }, CALC_DEBOUNCE_MS);

    function bindEvents() {
        DOM.coursesContainer.addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.delete-btn');
            if (deleteBtn) removeCourse(deleteBtn);
        });

        DOM.coursesContainer.addEventListener('change', (e) => {
            if (e.target.classList.contains('repeat-checkbox')) {
                toggleRepeat(e.target);
                debouncedCalculateAndSave();
            }
        });

        DOM.appContainer.addEventListener('input', () => { debouncedCalculateAndSave(); });
    }

    window.addEventListener('DOMContentLoaded', () => {
        cacheDOM();
        bindEvents();
        loadData();

        if (AppState.timeUpdateInterval) clearInterval(AppState.timeUpdateInterval);
        AppState.timeUpdateInterval = setInterval(updateSaveIndicator, SAVE_INDICATOR_REFRESH_MS);
    });

    // ==========================================
    // 2. إدارة التخزين المحلي ومؤشر الحفظ الذكي
    // ==========================================

    function updateSaveIndicator() {
        if (!AppState.lastSaveTime || !DOM.saveStatusText) return;
        const now = new Date();
        const diffSec = Math.floor((now - AppState.lastSaveTime) / 1000);

        if (diffSec < 10) {
            DOM.saveStatusText.innerText = 'تم الحفظ: الآن';
        } else if (diffSec < 60) {
            DOM.saveStatusText.innerText = 'تم الحفظ: قبل ثوانٍ';
        } else if (diffSec < 3600) {
            const mins = Math.floor(diffSec / 60);
            DOM.saveStatusText.innerText = `تم الحفظ: منذ ${mins} ${mins <= 10 && mins >= 3 ? 'دقائق' : 'دقيقة'}`;
        } else if (diffSec < 86400) {
            DOM.saveStatusText.innerText = `تم الحفظ: منذ ${Math.floor(diffSec / 3600)} ساعة`;
        } else {
            DOM.saveStatusText.innerText = `تم الحفظ: منذ ${Math.floor(diffSec / 86400)} يوم`;
        }
    }

    function saveUserData(dataToSave) {
        const saveTask = () => {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
            } catch (e) {
                console.warn('تعذر حفظ البيانات محلياً:', e);
            }
            updateSaveIndicator();
        };

        if ('requestIdleCallback' in window) {
            requestIdleCallback(saveTask);
        } else {
            setTimeout(saveTask, 50);
        }
    }

    function loadData() {
        try {
            const savedDataRaw = localStorage.getItem(STORAGE_KEY);
            if (!savedDataRaw) {
                AppState.currentTimestamp = new Date().getTime();
                AppState.lastSaveTime = new Date(AppState.currentTimestamp);
                addDefaultCourses();
                initChart(['المعدل الحالي', 'المعدل الجديد'], [0, 0], 0, 4);
                calculateGPA(false);
                return;
            }

            const savedData = JSON.parse(savedDataRaw);

            if (savedData.timestamp) {
                AppState.currentTimestamp = savedData.timestamp;
                AppState.lastSaveTime = new Date(savedData.timestamp);
            } else {
                AppState.currentTimestamp = new Date().getTime();
                AppState.lastSaveTime = new Date(AppState.currentTimestamp);
            }
            updateSaveIndicator();

            const isValidGPA = (val) => val === '' || (!isNaN(parseFloat(val)) && parseFloat(val) >= GRADE_MIN && parseFloat(val) <= GRADE_MAX);
            const isValidHours = (val) => val === '' || (!isNaN(parseInt(val, 10)) && parseInt(val, 10) >= 0);

            DOM.oldGpa.value = isValidGPA(savedData.oldGpa) ? (savedData.oldGpa || '') : '';
            DOM.oldHours.value = isValidHours(savedData.oldHours) ? (savedData.oldHours || '') : '';
            DOM.planTotal.value = isValidHours(savedData.planTotal) ? (savedData.planTotal || '') : '';
            DOM.planTarget.value = isValidGPA(savedData.planTarget) ? (savedData.planTarget || '') : '';
            DOM.hist1.value = isValidGPA(savedData.hist1) ? (savedData.hist1 || '') : '';
            DOM.hist2.value = isValidGPA(savedData.hist2) ? (savedData.hist2 || '') : '';

            if (savedData.courses && Array.isArray(savedData.courses) && savedData.courses.length > 0) {
                const fragment = document.createDocumentFragment();
                savedData.courses.forEach(course => {
                    fragment.appendChild(createCourseElement({
                        grade: course.grade || "",
                        hours: course.hours || "3",
                        isRepeated: !!course.isRepeated,
                        oldGrade: course.oldGrade || "1.00"
                    }));
                });
                DOM.coursesContainer.appendChild(fragment);
                updateCourseNumbers();
            } else {
                addDefaultCourses();
            }
        } catch (error) {
            console.warn('تعذرت قراءة البيانات المحفوظة، سيتم البدء من جديد:', error);
            localStorage.removeItem(STORAGE_KEY);
            DOM.coursesContainer.innerHTML = '';
            addDefaultCourses();
        }
        initChart(['المعدل الحالي', 'المعدل الجديد'], [0, 0], 0, 4);
        calculateGPA(false);

        // ننتظر تحميل المكتبة (إن لم تكن جاهزة) ثم نعيد الحساب لرسم المنحنى بالأرقام الحقيقية
        if (typeof Chart === 'undefined') {
            const chartScript = document.querySelector('script[src*="chart.js"]');
            if (chartScript) {
                chartScript.addEventListener('load', () => {
                    calculateGPA(false); 
                });
            }
        }
    }

    function resetCalculator() {
        if (confirm("هل أنت متأكد من رغبتك في تفريغ جميع البيانات وحذف المواد الحالية؟")) {
            localStorage.removeItem(STORAGE_KEY);
            DOM.oldGpa.value = ''; DOM.oldHours.value = ''; DOM.planTotal.value = ''; DOM.planTarget.value = '';
            DOM.hist1.value = ''; DOM.hist2.value = ''; DOM.coursesContainer.innerHTML = '';
            addDefaultCourses();
            AppState.hasCelebrated = true;
            AppState.isWarningState = false;
            DOM.appContainer.classList.remove('shake-animation');
            calculateGPA(true);
            hideUndoToast();
        }
    }

    function moveToNextSemester() {
        const newGpa = DOM.resultGpa.innerText;
        const newHours = parseInt(DOM.resultHours.innerText.replace(/[^0-9]/g, ''), 10) || 0;
        const currentOldGpa = DOM.oldGpa.value;
        const currentHist2 = DOM.hist2.value;

        if (parseFloat(newGpa) === 0 || isNaN(parseFloat(newGpa))) {
            alert("يرجى إدخال مواد وعلامات للفصل الحالي قبل الترحيل.");
            return;
        }

        if (confirm("هل تريد ترحيل هذا المعدل ليكون معدلك الحالي، والبدء بفصل جديد؟ \n(سيتم ترحيل معدلاتك السابقة في تتبع التطور تلقائياً)")) {
            if (currentHist2 !== "") DOM.hist1.value = currentHist2;
            if (currentOldGpa !== "") DOM.hist2.value = currentOldGpa;

            DOM.oldGpa.value = newGpa;
            DOM.oldHours.value = newHours;
            DOM.coursesContainer.innerHTML = '';
            addDefaultCourses();
            AppState.hasCelebrated = false;
            AppState.isWarningState = false;
            DOM.appContainer.classList.remove('shake-animation');
            calculateGPA(true);
            hideUndoToast();
        }
    }

    function autoFormatGPA(event) {
        if (event.inputType === 'deleteContentBackward') return;
        let input = event.target;
        let value = input.value.replace(/[^0-9]/g, '');

        if (value.length > 0) {
            let firstDigit = value.charAt(0);
            if (parseInt(firstDigit, 10) > GRADE_MAX) firstDigit = String(GRADE_MAX);
            let decimals = value.substring(1, 3);
            if (firstDigit === String(GRADE_MAX) && decimals.length > 0) decimals = decimals.replace(/[1-9]/g, '0');
            input.value = value.length === 1 ? firstDigit + '.' : firstDigit + '.' + decimals;
        } else {
            input.value = '';
        }
    }

    // إلغاء أي حركة سابقة على نفس العنصر قبل بدء حركة جديدة، لمنع تراكب rAF وتذبذب الأرقام
    function animateValue(obj, start, end, duration, isFloat = false, prefix = "", suffix = "") {
        const previousFrame = AppState.animFrames.get(obj);
        if (previousFrame) cancelAnimationFrame(previousFrame);

        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            const easeOutProgress = 1 - Math.pow(1 - progress, 3);
            let currentVal = easeOutProgress * (end - start) + start;

            let displayVal = isFloat ? currentVal.toFixed(2) : Math.round(currentVal);
            let htmlContent = prefix + displayVal + suffix;
            if (obj.innerHTML !== htmlContent) obj.innerHTML = htmlContent;

            if (progress < 1) {
                AppState.animFrames.set(obj, requestAnimationFrame(step));
            } else {
                let endDisplay = isFloat ? end.toFixed(2) : Math.round(end);
                obj.innerHTML = prefix + endDisplay + suffix;
                AppState.animFrames.delete(obj);
            }
        };
        AppState.animFrames.set(obj, requestAnimationFrame(step));
    }

    // ==========================================
    // 3. إدارة مواد الفصل الدراسي
    // ==========================================
    function toggleRepeat(checkbox) {
        const wrapper = checkbox.closest('.course-options').querySelector('.old-grade-wrapper');
        const card = checkbox.closest('.course-card');
        wrapper.classList.toggle('show', checkbox.checked);
        card.classList.toggle('repeated', checkbox.checked);
    }

    function addDefaultCourses() {
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < 4; i++) { fragment.appendChild(createCourseElement()); }
        DOM.coursesContainer.appendChild(fragment);
        updateCourseNumbers();
    }

    function createCourseElement(course = null) {
        const row = document.createElement('div');
        row.className = 'course-card';
        if (course && course.isRepeated) row.classList.add('repeated');

        let isChecked = course && course.isRepeated ? 'checked' : '';
        let wrapperClass = course && course.isRepeated ? 'old-grade-wrapper show' : 'old-grade-wrapper';

        row.innerHTML = `
            <div class="course-main">
                <span class="course-number course-number-box"></span>
                <select class="course-hours" aria-label="اختر عدد الساعات">
                    <option value="1" ${course && course.hours === '1' ? 'selected' : ''}>ساعة</option>
                    <option value="2" ${course && course.hours === '2' ? 'selected' : ''}>ساعتان</option>
                    <option value="3" ${!course || course.hours === '3' ? 'selected' : ''}>3 ساعات</option>
                    <option value="4" ${course && course.hours === '4' ? 'selected' : ''}>4 ساعات</option>
                    <option value="5" ${course && course.hours === '5' ? 'selected' : ''}>5 ساعات</option>
                    <option value="6" ${course && course.hours === '6' ? 'selected' : ''}>6 ساعات</option>
                </select>
                <select class="course-grade" aria-label="اختر العلامة">
                    <option value="" ${!course || course.grade === "" ? 'selected' : ''} disabled>اختر العلامة</option>
                    <option value="4.00" ${course && course.grade === '4.00' ? 'selected' : ''}>A</option>
                    <option value="3.75" ${course && course.grade === '3.75' ? 'selected' : ''}>A-</option>
                    <option value="3.50" ${course && course.grade === '3.50' ? 'selected' : ''}>B+</option>
                    <option value="3.25" ${course && course.grade === '3.25' ? 'selected' : ''}>(B)</option>
                    <option value="3.00" ${course && course.grade === '3.00' ? 'selected' : ''}>(B-)</option>
                    <option value="2.75" ${course && course.grade === '2.75' ? 'selected' : ''}>(C+)</option>
                    <option value="2.50" ${course && course.grade === '2.50' ? 'selected' : ''}>(C)</option>
                    <option value="2.25" ${course && course.grade === '2.25' ? 'selected' : ''}>(C-)</option>
                    <option value="2.00" ${course && course.grade === '2.00' ? 'selected' : ''}>(D+)</option>
                    <option value="1.25" ${course && course.grade === '1.25' ? 'selected' : ''}>(D)</option>
                    <option value="1.00" ${course && course.grade === '1.00' ? 'selected' : ''}>(D-) (رسوب)</option>
                </select>
                <button type="button" class="btn-icon delete-btn" aria-label="حذف المادة"><svg class="icon"><use href="#icon-trash"/></svg></button>
            </div>
            <div class="course-options">
                <label class="checkbox-label"><input type="checkbox" class="repeat-checkbox" ${isChecked}> مادة معادة؟</label>
                <div class="${wrapperClass}">
                    <label style="font-size: 0.7rem; color: var(--text-muted);">العلامة السّابقة:</label>
                    <select class="old-grade" aria-label="العلامة السابقة">
                        <option value="2.25" ${course && course.oldGrade === '2.25' ? 'selected' : ''}>(C-)</option>
                        <option value="2.00" ${course && course.oldGrade === '2.00' ? 'selected' : ''}>(D+)</option>
                        <option value="1.25" ${course && course.oldGrade === '1.25' ? 'selected' : ''}>(D)</option>
                        <option value="1.00" ${!course || course.oldGrade === '1.00' ? 'selected' : ''}>(D-) (رسوب)</option>
                    </select>
                </div>
            </div>
        `;
        return row;
    }

    function addCourse() {
        const row = createCourseElement();
        DOM.coursesContainer.appendChild(row);
        updateCourseNumbers();
        calculateGPA(true);
    }

    function updateCourseNumbers() {
        const cards = DOM.coursesContainer.querySelectorAll('.course-card');
        cards.forEach((card, index) => {
            const numberSpan = card.querySelector('.course-number');
            if (numberSpan) { numberSpan.innerText = index + 1; }
        });
    }

    function removeCourse(button) {
        const row = button.closest('.course-card');
        const allCards = Array.from(DOM.coursesContainer.querySelectorAll('.course-card'));
        const rowIndex = allCards.indexOf(row);

        if (allCards.length > 1) {
            AppState.deletedCourseState = {
                index: rowIndex,
                hours: row.querySelector('.course-hours').value,
                grade: row.querySelector('.course-grade').value,
                isRepeated: row.querySelector('.repeat-checkbox').checked,
                oldGrade: row.querySelector('.old-grade').value
            };

            row.classList.add('removing');
            setTimeout(() => {
                row.remove();
                updateCourseNumbers();
                debouncedCalculateAndSave();
                showUndoToast();
            }, 250);
        } else {
            alert("يجب إبقاء مادة واحدة على الأقل في الجدول.");
        }
    }

    function showUndoToast() {
        DOM.undoToast.classList.add('show');

        const circle = DOM.circlePath;
        if (circle) {
            circle.style.animation = 'none';
            void circle.offsetWidth;
            circle.style.animation = `circleCountdown ${UNDO_TIMEOUT_MS / 1000}s linear forwards`;
        }

        let timeLeft = UNDO_TIMEOUT_MS / 1000;
        DOM.undoTimerText.innerText = timeLeft;
        if (AppState.undoInterval) clearInterval(AppState.undoInterval);

        AppState.undoInterval = setInterval(() => {
            timeLeft--;
            if (timeLeft > 0) DOM.undoTimerText.innerText = timeLeft;
        }, 1000);

        if (AppState.undoToastTimeout) clearTimeout(AppState.undoToastTimeout);
        AppState.undoToastTimeout = setTimeout(() => {
            hideUndoToast();
        }, UNDO_TIMEOUT_MS);
    }

    function hideUndoToast() {
        DOM.undoToast.classList.remove('show');
        AppState.deletedCourseState = null;

        if (AppState.undoInterval) clearInterval(AppState.undoInterval);

        setTimeout(() => {
            if (DOM.circlePath) DOM.circlePath.style.animation = 'none';
        }, 400);
    }

    function undoDelete() {
        if (AppState.deletedCourseState) {
            const row = createCourseElement(AppState.deletedCourseState);
            const container = DOM.coursesContainer;
            const targetIndex = AppState.deletedCourseState.index;
            const referenceNode = container.children[targetIndex];

            if (referenceNode) {
                container.insertBefore(row, referenceNode);
            } else {
                container.appendChild(row);
            }

            updateCourseNumbers();
            calculateGPA(true);
            hideUndoToast();
            if (AppState.undoToastTimeout) clearTimeout(AppState.undoToastTimeout);
        }
    }

    // ==========================================
    // 4. العمليات الحسابية، التقدم، والتحذيرات
    // ==========================================
    function updateProgressSection(finalTotalHours, finalGpa) {
        const planTotal = parseFloat(DOM.planTotal.value) || 0;
        const planTarget = parseFloat(DOM.planTarget.value) || 0;

        if (planTotal > 0 && finalTotalHours > 0) {
            let percentage = Math.min(100, Math.round((finalTotalHours / planTotal) * 100));
            DOM.progressFill.style.width = `${percentage}%`;

            const currentPercent = parseFloat(DOM.progressPercent.innerText) || 0;
            animateValue(DOM.progressPercent, currentPercent, percentage, 600, false, "", "%");

            const remainingHours = planTotal - finalTotalHours;
            if (planTarget > 0) {
                if (remainingHours <= 0) {
                    DOM.progressNote.innerHTML = `<span style="color: var(--primary)">أنهيت الخطة 🎓</span>`;
                } else {
                    const requiredPoints = (planTotal * planTarget) - (finalTotalHours * finalGpa);
                    const requiredGpa = requiredPoints / remainingHours;

                    if (requiredGpa > GRADE_MAX) {
                        DOM.progressNote.innerHTML = `مستحيل رياضياً ❌`;
                    } else if (requiredGpa <= 0) {
                        DOM.progressNote.innerHTML = `<span style="color: var(--primary)">ضمنتها بالفعل ✅</span>`;
                    } else {
                        DOM.progressNote.innerHTML = `تحتاج لمعدل <b style="color: var(--primary)">${requiredGpa.toFixed(2)}</b> في <b>${remainingHours}</b> ساعة للهدف 🎯`;
                    }
                }
            } else {
                DOM.progressNote.innerText = `أنجزت ${finalTotalHours} من أصل ${planTotal} ساعة`;
            }
        } else {
            DOM.progressFill.style.width = `0%`;
            DOM.progressPercent.innerText = `0%`;
            DOM.progressNote.innerText = `أدخل إجمالي ساعات التخصص والمعدل المستهدف للحساب.`;
        }
    }

    function checkAcademicWarnings(finalTotalHours, finalGpa) {
        let ratingText = "-";
        if (finalTotalHours > 0) {
            if (finalGpa >= 3.69) ratingText = "امتياز 🥇";
            else if (finalGpa >= 3.00) ratingText = "جيد جداً 🥈";
            else if (finalGpa >= 2.50) ratingText = "جيد 🥉";
            else if (finalGpa >= 2.00) ratingText = "مقبول 👍";
            else ratingText = "ضعيف ⚠️";

            if (finalGpa < 2.00) {
                if (!AppState.isWarningState) {
                    DOM.appContainer.classList.remove('shake-animation');
                    void DOM.appContainer.offsetWidth;
                    DOM.appContainer.classList.add('shake-animation');
                    AppState.isWarningState = true;
                }
            } else {
                DOM.appContainer.classList.remove('shake-animation');
                AppState.isWarningState = false;
            }

            if (finalGpa >= 3.00 && !AppState.hasCelebrated) {
                triggerConfetti();
                AppState.hasCelebrated = true;
            } else if (finalGpa < 3.00) {
                AppState.hasCelebrated = false;
            }
        } else {
            DOM.appContainer.classList.remove('shake-animation');
            AppState.isWarningState = false;
            AppState.hasCelebrated = false;
        }
        DOM.gpaRating.innerHTML = `<svg class="icon"><use href="#icon-award"/></svg> التّقدير: ${ratingText}`;
    }

    // isUserAction: true إذا كان التعديل ناتجاً عن فعل مباشر من الطالب (لتحديث وقت الحفظ)
    function calculateGPA(isUserAction = false) {

        if (isUserAction) {
            AppState.currentTimestamp = new Date().getTime();
            AppState.lastSaveTime = new Date(AppState.currentTimestamp);
        }

        const oldGpa = parseFloat(DOM.oldGpa.value) || 0;
        const oldHours = parseFloat(DOM.oldHours.value) || 0;

        let oldTotalPoints = oldGpa * oldHours;
        let finalTotalHours = oldHours;
        let newSemesterPoints = 0;
        let newSemesterHours = 0;
        let registeredSemesterHours = 0;

        const dataToSave = {
            oldGpa: DOM.oldGpa.value,
            oldHours: DOM.oldHours.value,
            planTotal: DOM.planTotal.value,
            planTarget: DOM.planTarget.value,
            hist1: DOM.hist1.value,
            hist2: DOM.hist2.value,
            timestamp: AppState.currentTimestamp,
            courses: []
        };

        const cards = DOM.coursesContainer.querySelectorAll('.course-card');

        cards.forEach(row => {
            const hoursInput = row.querySelector('.course-hours').value;
            const hours = parseFloat(hoursInput) || 0;
            const gradeInput = row.querySelector('.course-grade').value;
            const isRepeated = row.querySelector('.repeat-checkbox').checked;
            const oldGradeInput = row.querySelector('.old-grade').value;

            dataToSave.courses.push({ hours: hoursInput, grade: gradeInput, isRepeated: isRepeated, oldGrade: oldGradeInput });

            registeredSemesterHours += hours;
            if (gradeInput !== "") {
                const gradeValue = parseFloat(gradeInput) || 0;
                if (!isRepeated) finalTotalHours += hours;
                newSemesterPoints += (hours * gradeValue);
                newSemesterHours += hours;
                if (isRepeated) oldTotalPoints -= (hours * (parseFloat(oldGradeInput) || 0));
            }
        });

        saveUserData(dataToSave);

        const semesterGpa = newSemesterHours > 0 ? newSemesterPoints / newSemesterHours : 0;
        const finalTotalPoints = oldTotalPoints + newSemesterPoints;
        const finalGpa = finalTotalHours > 0 ? finalTotalPoints / finalTotalHours : 0;

        const currentGpa = parseFloat(DOM.resultGpa.innerText) || 0;
        const currentSemGpa = parseFloat(DOM.semesterGpaBadge.innerText.replace(/[^0-9.]/g, '')) || 0;
        const currentHours = parseInt(DOM.resultHours.innerText.replace(/[^0-9]/g, ''), 10) || 0;
        const currentRegHours = parseInt(DOM.semesterHoursBadge.innerText.replace(/[^0-9]/g, ''), 10) || 0;

        animateValue(DOM.resultGpa, currentGpa, finalGpa, 250, true, "");
        animateValue(DOM.semesterGpaBadge, currentSemGpa, semesterGpa, 250, true, `<svg class="icon"><use href="#icon-pie"/></svg> المعدل الفصلي:  `);
        animateValue(DOM.resultHours, currentHours, finalTotalHours, 250, false, `<svg class="icon"><use href="#icon-clock"/></svg> مجموع السّاعات: `);
        animateValue(DOM.semesterHoursBadge, currentRegHours, registeredSemesterHours, 250, false, `ساعات الفصل: `);

        updateProgressSection(finalTotalHours, finalGpa);
        checkAcademicWarnings(finalTotalHours, finalGpa);
        updateChart(oldGpa, finalGpa);
    }

    // ==========================================
    // 5. الرسم البياني والاحتفالات (Confetti)
    // ==========================================
    function updateChart(oldGpa, finalGpa) {
        let chartLabels = [];
        let chartData = [];
        let h1 = parseFloat(DOM.hist1.value);
        let h2 = parseFloat(DOM.hist2.value);

        if (!isNaN(h1)) { chartLabels.push(`المعدل الأقدم`); chartData.push(h1); }
        if (!isNaN(h2)) { chartLabels.push(`المعدل السّابق`); chartData.push(h2); }
        if (oldGpa > 0) { chartLabels.push('المعدل الحالي'); chartData.push(oldGpa); }
        chartLabels.push('المعدل الجديد'); chartData.push(parseFloat(finalGpa.toFixed(2)));

        const currentDataString = JSON.stringify({ labels: chartLabels, data: chartData });
        if (currentDataString === AppState.lastChartDataString && AppState.chartInstance) return;
        AppState.lastChartDataString = currentDataString;

        let yMin = 0;
        let yMax = GRADE_MAX;
        if (chartData.length > 0) {
            let minData = Math.min(...chartData);
            let maxData = Math.max(...chartData);
            yMin = Math.max(0, minData - 0.15);
            yMax = Math.min(GRADE_MAX, maxData + 0.15);
        }
        initChart(chartLabels, chartData, yMin, yMax);
    }

    async function loadConfettiLib() {
        if (window.confetti) return Promise.resolve();
        if (AppState.confettiPromise) return AppState.confettiPromise;
        AppState.confettiPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js';
            script.onload = resolve; script.onerror = reject;
            document.head.appendChild(script);
        });
        return AppState.confettiPromise;
    }

    async function triggerConfetti() {
        try { await loadConfettiLib(); } catch (e) { return; }
        const duration = 3 * 1000;
        const end = Date.now() + duration;
        (function frame() {
            confetti({ particleCount: 5, angle: 60, spread: 55, origin: { x: 0 }, colors: ['#006838', '#f3c300', '#ffffff'] });
            confetti({ particleCount: 5, angle: 120, spread: 55, origin: { x: 1 }, colors: ['#006838', '#f3c300', '#ffffff'] });
            if (Date.now() < end) requestAnimationFrame(frame);
        }());
    }

    function initChart(labelsArray, dataArray, yMin, yMax) {
        const canvas = document.getElementById('gpaChart');
        if (!canvas || typeof Chart === 'undefined') return; // Chart.js لم يُحمّل بعد
        const ctx = canvas.getContext('2d');
        if (AppState.chartInstance) {
            AppState.chartInstance.data.labels = labelsArray;
            AppState.chartInstance.data.datasets[0].data = dataArray;
            AppState.chartInstance.options.scales.y.min = yMin;
            AppState.chartInstance.options.scales.y.max = yMax;
            AppState.chartInstance.update();
            return;
        }

        if (!canvas || typeof Chart === 'undefined') return; // Chart.js لم يُحمّل بعد

        let gradient = ctx.createLinearGradient(0, 0, 0, 350);
        gradient.addColorStop(0, 'rgba(243, 195, 0, 0.5)');
        gradient.addColorStop(1, 'rgba(243, 195, 0, 0.0)');
        AppState.chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labelsArray,
                datasets: [{
                    label: 'المعدل', data: dataArray, borderColor: '#f3c300', backgroundColor: gradient,
                    borderWidth: 4, pointBackgroundColor: '#ffffff', pointBorderColor: '#f3c300',
                    pointBorderWidth: 3, pointRadius: 6, pointHoverRadius: 9, fill: true, tension: 0.4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: { duration: 300, easing: 'easeOutQuart' },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (context) { return ' المعدل: ' + context.parsed.y; } } } },
                scales: {
                    y: { min: yMin, max: yMax, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 14 } } },
                    x: { grid: { display: false }, ticks: { color: 'rgba(255, 255, 255, 0.9)', font: { family: 'Tajawal', size: 13 } } }
                }
            }
        });
    }