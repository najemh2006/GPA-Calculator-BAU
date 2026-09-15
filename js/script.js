'use strict';

    const UNDO_TIMEOUT_MS = 5000;
    const SAVE_INDICATOR_REFRESH_MS = 10000;
    const CALC_DEBOUNCE_MS = 150;
    const STORAGE_KEY = 'bau_gpa_calculator_data';
    const GRADE_MIN = 0;
    const GRADE_MAX = 4;
    const MAX_HOURS = 256;
    const MIN_PLAN_HOURS = 132;
    const MAX_COURSES = 12; // أقصى عدد مواد منطقي في الفصل الواحد



    const AppState = {
        chartInstance: null,
        hasCelebrated: false,
        isWarningState: false,
        confettiPromise: null,
        undoAction: null, // دالة التراجع الحالية للتوست (حذف مادة أو ترحيل فصل)
        gpaHistory: [], // سجل المعدلات التراكمية التلقائي: أقدم → الأحدث (حد أقصى 6)
        undoToastTimeout: null,
        warnTimeout: null, // مؤقت إخفاء رسالة التحذير المؤقتة (5 ثوانٍ)
        undoInterval: null,
        lastSaveTime: null,
        timeUpdateInterval: null,
        lastChartDataString: "",
        currentTimestamp: null,
        // آخر نتائج محسوبة فعلياً (تُستخدم في الترحيل بدل قراءة الأرقام أثناء أنيميشنها)
        lastComputed: { gpa: 0, hours: 0, semHours: 0 },
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
        // نص رسالة التراجع (span النص داخل التوست — ليس عدّاد الثواني)
        DOM.undoToastMsg = Array.from(DOM.undoToast.querySelectorAll('span')).find(s => s.id !== 'undoTimerText');

        // صندوق الإدخال اليدوي للتتبع (يظهر دائماً الآن بعد إلغاء نظام الشارات)
        DOM.historyContainer = document.querySelector('.history-container');

        // رسالة التحذير العائمة: بطاقة أنيقة خارج الصندوق تماماً —
        // لا تمس ترتيب أو شكل القسم الأيسر إطلاقاً
        DOM.warnToast = document.createElement('div');
        DOM.warnToast.className = 'bau-warn-toast';
        DOM.warnToast.setAttribute('role', 'alert');
        document.body.appendChild(DOM.warnToast);
        const warnStyle = document.createElement('style');
        warnStyle.textContent = `
            .bau-warn-toast {
                position: fixed; bottom: 110px; left: 50%;
                transform: translateX(-50%);
                background: #ffffff;
                border: 1px solid #fee2e2;
                border-radius: 16px;
                padding: 14px 18px 17px;
                display: flex; align-items: center; gap: 12px;
                max-width: min(440px, 92%);
                overflow: hidden; /* قصّ الشريط والمحتوى عند الزوايا المدوّرة */
                box-shadow: 0 18px 45px rgba(0, 0, 0, 0.22), 0 0 0 4px rgba(218, 41, 28, 0.05);
                z-index: 9999;
                opacity: 0;
                pointer-events: none;
            }
            .bau-warn-toast.show { animation: bauWarnIn 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.12) forwards; }
            .bau-warn-toast.hide { transition: opacity 0.3s ease, transform 0.3s ease; opacity: 0 !important; transform: translateX(-50%) translateY(16px) !important; }
            .bau-warn-toast .warn-icon {
                width: 38px; height: 38px; border-radius: 50%;
                background: rgba(218, 41, 28, 0.1);
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0;
            }
            .bau-warn-toast .warn-icon svg {
                width: 20px; height: 20px;
                fill: none; stroke: var(--danger);
                stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
            }
            .bau-warn-toast .warn-title { font-weight: 800; color: var(--danger); font-size: 0.9rem; }
            .bau-warn-toast .warn-msg { font-weight: 600; color: #334155; font-size: 0.85rem; margin-top: 2px; }
            .bau-warn-toast .warn-bar {
                position: absolute; bottom: 0; inset-inline-start: 0;
                height: 3px; width: 100%;
                background: rgba(218, 41, 28, 0.1);
            }
            .bau-warn-toast .warn-bar > span {
                display: block; height: 100%;
                background: linear-gradient(90deg, #ef4444, var(--danger));
                border-radius: 3px;
                animation: bauWarnBar 5s linear forwards;
            }
            @keyframes bauWarnIn {
                0% { opacity: 0; transform: translateX(-50%) translateY(26px) scale(0.94); }
                60% { opacity: 1; transform: translateX(-50%) translateY(-5px) scale(1.015); }
                100% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
            }
            @keyframes bauWarnBar { from { width: 100%; } to { width: 0%; } }
            @media (max-width: 600px) {
                .bau-warn-toast { bottom: 95px; padding: 11px 14px 14px; gap: 10px; }
                .bau-warn-toast .warn-icon { width: 32px; height: 32px; font-size: 1rem; }
            }
        `;
        document.head.appendChild(warnStyle);


        // منع تشغيل أنيميشن الملاحظة عند أول تحميل للصفحة
        NoteAnim.key = 'idle';
    }

    function debounce(func, delay) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => { func.apply(this, args); }, delay);
        };
    }

    // إعادة تشغيل أنيميشن CSS على عنصر (بإزالة الكلاس وإعادة إضافته بعد reflow)
    function retriggerAnimation(el, className) {
        el.classList.remove(className);
        void el.offsetWidth;
        el.classList.add(className);
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

            // تغيير قائمة العلامات عند اختيار 0 ساعة
            if (e.target.classList.contains('course-hours')) {
                const courseCard = e.target.closest('.course-card');
                const gradeSelect = courseCard.querySelector('.course-grade');
                const repeatLabel = courseCard.querySelector('.checkbox-label');
                const repeatCheckbox = courseCard.querySelector('.repeat-checkbox');
                const isZeroHours = e.target.value === "0";

                if (isZeroHours) {
                    gradeSelect.innerHTML = `
                        <option value="" selected disabled>اختر النتيجة</option>
                        <option value="pass">ناجح</option>
                        <option value="fail">راسب</option>
                    `;
                    // إخفاء خيار "مادة معادة؟" لأنه لا معنى له مع مادة بصفر ساعة
                    if (repeatLabel) repeatLabel.style.display = 'none';
                    if (repeatCheckbox && repeatCheckbox.checked) {
                        repeatCheckbox.checked = false;
                        toggleRepeat(repeatCheckbox);
                    }
                } else {
                    gradeSelect.innerHTML = `
                        <option value="" selected disabled>اختر العلامة</option>
                        <option value="pass">ناجح (لا تُحتسب بالمعدل)</option>
                        <option value="4.00">A</option>
                        <option value="3.75">-A</option>
                        <option value="3.50">+B</option>
                        <option value="3.25">(B)</option>
                        <option value="3.00">(-B)</option>
                        <option value="2.75">(+C)</option>
                        <option value="2.50">(C)</option>
                        <option value="2.25">(-C)</option>
                        <option value="2.00">(+D)</option>
                        <option value="1.25">(D)</option>
                        <option value="1.00">(رسوب) (-D)</option>
                    `;
                    // إعادة إظهار الخيار عند تغيير عدد الساعات لأكثر من صفر
                    if (repeatLabel) repeatLabel.style.display = '';
                }

                // نبضة خفيفة على قائمة العلامات عند إعادة بناء خياراتها
                retriggerAnimation(gradeSelect, 'select-pulse');

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

    // صيغة الجمع العربية الصحيحة: 1 دقيقة، دقيقتان، 3-10 دقائق، 11+ دقيقة
    function pluralize(count, one, two, few, many) {
        if (count === 1) return one;
        if (count === 2) return two;
        if (count >= 3 && count <= 10) return few;
        return many;
    }

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
            DOM.saveStatusText.innerText = `تم الحفظ: منذ ${mins} ${pluralize(mins, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}`;
        } else if (diffSec < 86400) {
            const hrs = Math.floor(diffSec / 3600);
            DOM.saveStatusText.innerText = `تم الحفظ: منذ ${hrs} ${pluralize(hrs, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`;
        } else {
            const days = Math.floor(diffSec / 86400);
            DOM.saveStatusText.innerText = `تم الحفظ: منذ ${days} ${pluralize(days, 'يوم', 'يومين', 'أيام', 'يوم')}`;
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

            // استرجاع سجل التطور التلقائي المحفوظ (مع تنقية القيم غير الصالحة)
            AppState.gpaHistory = Array.isArray(savedData.gpaHistory)
                ? savedData.gpaHistory.map(v => parseFloat(v)).filter(v => !isNaN(v) && v >= GRADE_MIN && v <= GRADE_MAX)
                : [];

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
            AppState.gpaHistory = [];
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
        // نستخدم النتائج المحسوبة فعلياً بدلاً من قراءة الشاشة أثناء أنيميشن الأرقام
        const computed = AppState.lastComputed;

        if (!computed || computed.semHours === 0) {
            alert("يرجى إدخال مواد وعلامات للفصل الحالي قبل الترحيل.");
            return;
        }

        // منع الترحيل المزدوج: إذا كانت النتيجة المحسوبة مطابقة لما هو مسجل حالياً
        // (أي لا مواد جديدة أُدخلت منذ آخر ترحيل) فلا داعي للترحيل وإتلاف السجل
        const currentOldGpa = parseFloat(DOM.oldGpa.value) || 0;
        const currentOldHours = parseInt(DOM.oldHours.value, 10) || 0;
        if (Math.abs(computed.gpa - currentOldGpa) < 0.005 && computed.hours === currentOldHours) {
            alert("لا توجد نتائج جديدة للترحيل — أدخل مواد الفصل الحالي أولاً.");
            return;
        }

        const newGpa = computed.gpa.toFixed(2);
        const newHours = computed.hours;
        const currentHist2 = DOM.hist2.value;

        if (confirm("هل تريد ترحيل هذا المعدل ليكون معدلك الحالي، والبدء بفصل جديد؟ \n(سيتم حفظ معدلك الحالي في سجل التطور تلقائياً، ويمكنك التراجع خلال 5 ثوانٍ)")) {
            // لقطة كاملة للحالة الحالية تتيح التراجع عن الترحيل
            const prevGpaVal = DOM.oldGpa.value;
            const snapshot = {
                oldGpa: prevGpaVal,
                oldHours: DOM.oldHours.value,
                hist1: DOM.hist1.value,
                hist2: DOM.hist2.value,
                gpaHistory: [...AppState.gpaHistory],
                hasCelebrated: AppState.hasCelebrated,
                courses: Array.from(DOM.coursesContainer.querySelectorAll('.course-card')).map(row => ({
                    hours: row.querySelector('.course-hours').value,
                    grade: row.querySelector('.course-grade').value,
                    isRepeated: row.querySelector('.repeat-checkbox').checked,
                    oldGrade: row.querySelector('.old-grade').value
                }))
            };

            // (11) حفظ المعدل التراكمي الحالي في سجل التطور التلقائي (حد أقصى 6 فصول)
            const prevGpaNum = parseFloat(prevGpaVal);
            if (!isNaN(prevGpaNum) && prevGpaNum > 0) {
                AppState.gpaHistory.push(prevGpaNum);
                if (AppState.gpaHistory.length > 6) AppState.gpaHistory.shift();
            }

            if (prevGpaVal !== "" && prevGpaVal !== DOM.hist2.value) DOM.hist2.value = prevGpaVal;
            if (currentHist2 !== "" && currentHist2 !== DOM.hist1.value) DOM.hist1.value = currentHist2;

            DOM.oldGpa.value = newGpa;
            DOM.oldHours.value = newHours;
            DOM.coursesContainer.innerHTML = '';
            addDefaultCourses();
            // منع انفجار القصاصات مباشرة بعد الترحيل إذا كان المعدل مرتفعاً أصلاً
            AppState.hasCelebrated = computed.gpa >= 3.00;
            AppState.isWarningState = false;
            DOM.appContainer.classList.remove('shake-animation');
            calculateGPA(true);

            // (8) توست تراجع يعيد كل شيء كما كان قبل الترحيل
            showUndoToast('تم ترحيل الفصل', () => {
                DOM.oldGpa.value = snapshot.oldGpa;
                DOM.oldHours.value = snapshot.oldHours;
                DOM.hist1.value = snapshot.hist1;
                DOM.hist2.value = snapshot.hist2;
                AppState.gpaHistory = [...snapshot.gpaHistory];
                AppState.hasCelebrated = snapshot.hasCelebrated;
                DOM.coursesContainer.innerHTML = '';
                const fragment = document.createDocumentFragment();
                snapshot.courses.forEach(c => fragment.appendChild(createCourseElement(c)));
                DOM.coursesContainer.appendChild(fragment);
                updateCourseNumbers();
                calculateGPA(true);
            });
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

        const isZeroHours = course && course.hours === '0';

        if (course && course.isRepeated && !isZeroHours) row.classList.add('repeated');

        let isChecked = (course && course.isRepeated && !isZeroHours) ? 'checked' : '';
        let wrapperClass = (course && course.isRepeated && !isZeroHours) ? 'old-grade-wrapper show' : 'old-grade-wrapper';
        let repeatLabelStyle = isZeroHours ? ' style="display:none;"' : '';

        let gradeOptions = "";

        if (isZeroHours) {
            gradeOptions = `
                <option value="" ${!course || course.grade === "" ? 'selected' : ''} disabled>اختر النتيجة</option>
                <option value="pass" ${course && course.grade === 'pass' ? 'selected' : ''}>ناجح</option>
                <option value="fail" ${course && course.grade === 'fail' ? 'selected' : ''}>راسب</option>
            `;
        } else {
            gradeOptions = `
                <option value="" ${!course || course.grade === "" ? 'selected' : ''} disabled>اختر العلامة</option>
                <option value="pass" ${course && course.grade === 'pass' ? 'selected' : ''}>ناجح (لا تُحتسب بالمعدل)</option>
                <option value="4.00" ${course && course.grade === '4.00' ? 'selected' : ''}>A</option>
                <option value="3.75" ${course && course.grade === '3.75' ? 'selected' : ''}>-A</option>
                <option value="3.50" ${course && course.grade === '3.50' ? 'selected' : ''}>+B</option>
                <option value="3.25" ${course && course.grade === '3.25' ? 'selected' : ''}>(B)</option>
                <option value="3.00" ${course && course.grade === '3.00' ? 'selected' : ''}>(-B)</option>
                <option value="2.75" ${course && course.grade === '2.75' ? 'selected' : ''}>(+C)</option>
                <option value="2.50" ${course && course.grade === '2.50' ? 'selected' : ''}>(C)</option>
                <option value="2.25" ${course && course.grade === '2.25' ? 'selected' : ''}>(-C)</option>
                <option value="2.00" ${course && course.grade === '2.00' ? 'selected' : ''}>(+D)</option>
                <option value="1.25" ${course && course.grade === '1.25' ? 'selected' : ''}>(D)</option>
                <option value="1.00" ${course && course.grade === '1.00' ? 'selected' : ''}>(رسوب) (-D)</option>
            `;
        }

        row.innerHTML = `
            <div class="course-main">
                <span class="course-number course-number-box"></span>
                <select class="course-hours" aria-label="اختر عدد الساعات">
                    <option value="0" ${course && course.hours === '0' ? 'selected' : ''}>0 ساعة</option>
                    <option value="1" ${course && course.hours === '1' ? 'selected' : ''}>ساعة</option>
                    <option value="2" ${course && course.hours === '2' ? 'selected' : ''}>ساعتان</option>
                    <option value="3" ${!course || course.hours === '3' ? 'selected' : ''}>3 ساعات</option>
                    <option value="4" ${course && course.hours === '4' ? 'selected' : ''}>4 ساعات</option>
                    <option value="5" ${course && course.hours === '5' ? 'selected' : ''}>5 ساعات</option>
                    <option value="6" ${course && course.hours === '6' ? 'selected' : ''}>6 ساعات</option>
                </select>
                <select class="course-grade" aria-label="اختر العلامة">
                    ${gradeOptions}
                </select>
                <button type="button" class="btn-icon delete-btn" aria-label="حذف المادة"><svg class="icon"><use href="#icon-trash"/></svg></button>
            </div>
            <div class="course-options">
                <label class="checkbox-label"${repeatLabelStyle}><input type="checkbox" class="repeat-checkbox" ${isChecked}> مادة معادة؟</label>
                <div class="${wrapperClass}">
                    <label style="font-size: 0.7rem; color: var(--text-muted);">العلامة السّابقة:</label>
                    <select class="old-grade" aria-label="العلامة السابقة">
                        <option value="2.25" ${course && course.oldGrade === '2.25' ? 'selected' : ''}>(-C)</option>
                        <option value="2.00" ${course && course.oldGrade === '2.00' ? 'selected' : ''}>(+D)</option>
                        <option value="1.25" ${course && course.oldGrade === '1.25' ? 'selected' : ''}>(D)</option>
                        <option value="1.00" ${!course || course.oldGrade === '1.00' ? 'selected' : ''}>(رسوب) (-D)</option>
                    </select>
                </div>
            </div>
        `;
        return row;
    }

    function addCourse() {
        // منع الإفراط: أكثر من 12 مادة في فصل واحد غير منطقي أكاديمياً
        const count = DOM.coursesContainer.querySelectorAll('.course-card').length;
        if (count >= MAX_COURSES) {
            alert(`لا يمكن إضافة أكثر من ${MAX_COURSES} مادة في الفصل الواحد.`);
            return;
        }
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
            const hoursVal = row.querySelector('.course-hours').value;
            const deletedState = {
                index: rowIndex,
                hours: hoursVal,
                grade: row.querySelector('.course-grade').value,
                // مادة الصفر ساعة لا يوجد لها خيار "مادة معادة" => تطبيع القيمة
                isRepeated: hoursVal !== '0' && row.querySelector('.repeat-checkbox').checked,
                oldGrade: row.querySelector('.old-grade').value
            };

            row.classList.add('removing');
            setTimeout(() => {
                row.remove();
                updateCourseNumbers();
                debouncedCalculateAndSave();
                // التراجع يُعيد المادة لمكانها الأصلي في القائمة
                showUndoToast('تم حذف المادة', () => {
                    const restored = createCourseElement({
                        ...deletedState,
                        isRepeated: deletedState.hours !== '0' && !!deletedState.isRepeated
                    });
                    const referenceNode = DOM.coursesContainer.children[deletedState.index];
                    if (referenceNode) DOM.coursesContainer.insertBefore(restored, referenceNode);
                    else DOM.coursesContainer.appendChild(restored);
                    updateCourseNumbers();
                    calculateGPA(true);
                });
            }, 250);
        } else {
            alert("يجب إبقاء مادة واحدة على الأقل في الجدول.");
        }
    }

    function showUndoToast(message, action) {
        if (DOM.undoToastMsg) DOM.undoToastMsg.innerText = message;
        AppState.undoAction = action;
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

    // رسالة تحذير عائمة: بطاقة بأيقونة وعنوان وشريط عدّاد 5 ثوانٍ
    function showWarnBanner(message) {
        if (!DOM.warnToast) return;
        DOM.warnToast.classList.remove('hide');
        DOM.warnToast.innerHTML = `
            <div class="warn-icon"><svg viewBox="0 0 24 24"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
            <div>
                <div class="warn-title">تنبيه أكاديمي</div>
                <div class="warn-msg">${message}</div>
            </div>
            <div class="warn-bar"><span></span></div>`;
        // إعادة تشغيل أنيميشن الدخول من جديد
        DOM.warnToast.classList.remove('show');
        void DOM.warnToast.offsetWidth;
        DOM.warnToast.classList.add('show');
        if (AppState.warnTimeout) clearTimeout(AppState.warnTimeout);
        AppState.warnTimeout = setTimeout(hideWarnBanner, 5000);
    }

    function hideWarnBanner() {
        if (!DOM.warnToast) return;
        DOM.warnToast.classList.remove('show');
        DOM.warnToast.classList.add('hide');
        if (AppState.warnTimeout) {
            clearTimeout(AppState.warnTimeout);
            AppState.warnTimeout = null;
        }
    }

    function hideUndoToast() {
        DOM.undoToast.classList.remove('show');
        AppState.undoAction = null;

        if (AppState.undoInterval) clearInterval(AppState.undoInterval);

        setTimeout(() => {
            if (DOM.circlePath) DOM.circlePath.style.animation = 'none';
        }, 400);
    }

    // معالج زر "تراجع" في التوست — يعمل لكل العمليات (حذف مادة / ترحيل فصل)
    function undoDelete() {
        if (AppState.undoAction) {
            const action = AppState.undoAction;
            if (AppState.undoToastTimeout) clearTimeout(AppState.undoToastTimeout);
            hideUndoToast();
            action();
        }
    }

    // ==========================================
    // 4. العمليات الحسابية، التقدم، والتحذيرات
    // ==========================================

    // حالة أنيميشن الملاحظة: القالب الحالي (للتمييز بين تغيّر الجملة وتغيّر الأرقام فقط)
    const NoteAnim = { key: null };

    /**
     * setNote: إذا تغيّر قالب الجملة => تلاشٍ كامل (text-fade) وتُضبط الأرقام فوراً.
     * إذا ثبت القالب وتغيّرت الأرقام فقط => أنيميشن counter على الأرقام داخل الجملة (بلا تلاشٍ).
     * القيم تُوضع داخل <span class="note-val"> بالترتيب المطابق لمصفوفة values.
     */
    function setNote(key, html, values = [], isFloat = []) {
        const note = DOM.progressNote;

        if (NoteAnim.key === key) {
            if (values.length > 0) {
                // القالب ثابت: counter للأرقام فقط عند تغيّرها
                const spans = note.querySelectorAll('.note-val');
                values.forEach((v, i) => {
                    const span = spans[i];
                    if (!span) return;
                    const current = parseFloat(span.textContent) || 0;
                    if (current !== v) animateValue(span, current, v, 600, !!isFloat[i]);
                });
                return;
            }
            // قالب بلا أرقام: إذا لم يتغير شيء فلا أنيميشن إطلاقاً
            if (note.innerHTML === html) return;
        }

        NoteAnim.key = key;
        note.innerHTML = html;
        const spans = note.querySelectorAll('.note-val');
        values.forEach((v, i) => {
            if (spans[i]) spans[i].textContent = isFloat[i] ? v.toFixed(2) : String(Math.round(v));
        });
        retriggerAnimation(note, 'text-fade');
    }

    function updateProgressSection(finalTotalHours, gpaHours, finalGpa) {
        const planTotal = parseFloat(DOM.planTotal.value) || 0;
        const planTarget = parseFloat(DOM.planTarget.value) || 0;

        // عدم اتساق البيانات: الساعات المنجزة أكبر من خطة التخصص (غالباً رقم الخطة خطأ).
        // نُنبه المستخدم ونُظلل الحقل — ولا نقصّ أي رقم لأن ذلك يُفسد حساب المعدل.
        const planInconsistent = planTotal > 0 && finalTotalHours > planTotal;
        if (planInconsistent) {
            DOM.planTotal.style.borderColor = 'var(--danger)';
            DOM.planTotal.style.boxShadow = '0 0 0 3px rgba(218, 41, 28, 0.15)';
        } else {
            DOM.planTotal.style.borderColor = '';
            DOM.planTotal.style.boxShadow = '';
        }

        if (planInconsistent) {
            const percentage = 100;
            DOM.progressFill.style.width = `${percentage}%`;
            const currentPercent = parseFloat(DOM.progressPercent.innerText) || 0;
            if (currentPercent !== percentage) {
                animateValue(DOM.progressPercent, currentPercent, percentage, 600, false, "", "%");
            }
            setNote('plan-warning', `⚠️ الساعات المنجزة (<b><span class="note-val">0</span></b>) تتجاوز خطة التخصص (<b><span class="note-val">0</span></b>) — راجع إجمالي ساعات التخصص`, [finalTotalHours, planTotal], [false, false]);
        } else if (planTotal > 0 && finalTotalHours > 0) {
            let percentage = Math.min(100, Math.round((finalTotalHours / planTotal) * 100));
            DOM.progressFill.style.width = `${percentage}%`;

            // أنيميشن counter للنسبة عند تغيّرها
            const currentPercent = parseFloat(DOM.progressPercent.innerText) || 0;
            if (currentPercent !== percentage) {
                animateValue(DOM.progressPercent, currentPercent, percentage, 600, false, "", "%");
            }

            const remainingHours = planTotal - finalTotalHours;
            if (planTarget > 0) {
                if (remainingHours <= 0) {
                    if (finalGpa >= planTarget) {
                        setNote('done', `<span style="color: var(--primary)">أنهيت الخطة 🎓</span>`);
                    } else {
                        setNote('done-missed', `<span style="color: var(--danger)">أنهيت الخطة دون الوصول للمعدل المستهدف</span>`);
                    }
                } else {
                    // النقاط المكتسبة = الساعات المحتسبة في المعدل × المعدل
                    // (وليست إجمالي الساعات المُنجزة، لأن مواد "ناجح" تُضاف للساعات بلا نقاط)
                    const earnedPoints = gpaHours * finalGpa;
                    const requiredPoints = (planTotal * planTarget) - earnedPoints;
                    const requiredGpa = requiredPoints / remainingHours;

                    if (requiredGpa > GRADE_MAX) {
                        setNote('impossible', `مستحيل رياضياً ❌`);
                    } else if (requiredGpa <= 0) {
                        setNote('secured', `<span style="color: var(--primary)">ضمنتها بالفعل ✅</span>`);
                    } else {
                        // القالب ثابت => الأرقام (المعدل المطلوب والساعات المتبقية) بأنيميشن counter
                        setNote('need', `تحتاج لمعدل <b style="color: var(--primary)"><span class="note-val">0.00</span></b> في <b><span class="note-val">0</span></b> ساعة للهدف 🎯`, [requiredGpa, remainingHours], [true, false]);
                    }
                }
            } else {
                setNote('hours-progress', `أنجزت <b><span class="note-val">0</span></b> من أصل <b><span class="note-val">0</span></b> ساعة`, [finalTotalHours, planTotal], [false, false]);
            }
        } else {
            DOM.progressFill.style.width = `0%`;
            DOM.progressPercent.innerText = `0%`;
            setNote('idle', `أدخل إجمالي ساعات التخصص والمعدل المستهدف للحساب.`);
        }
    }

    // isUserAction: الاهتزاز والاحتفال يعملان فقط مع تفاعل المستخدم (لا عند فتح الصفحة أو تحميل المكتبات)
    function checkAcademicWarnings(finalTotalHours, finalGpa, isUserAction) {
        let ratingText = "-";
        if (finalTotalHours > 0) {
            if (finalGpa >= 3.69) ratingText = "امتياز 🥇";
            else if (finalGpa >= 3.00) ratingText = "جيد جداً 🥈";
            else if (finalGpa >= 2.50) ratingText = "جيد 🥉";
            else if (finalGpa >= 2.00) ratingText = "مقبول 👍";
            else ratingText = "ضعيف ⚠️";

            if (finalGpa < 2.00) {
                if (isUserAction && !AppState.isWarningState) {
                    DOM.appContainer.classList.remove('shake-animation');
                    void DOM.appContainer.offsetWidth;
                    DOM.appContainer.classList.add('shake-animation');
                    AppState.isWarningState = true;
                    // رسالة تحذير مؤقتة (5 ثوانٍ) عند العبور تحت الحد الأدنى
                    showWarnBanner(`معدلك التراكمي ${finalGpa.toFixed(2)} تحت الحد الأدنى (2.00)`);
                }
            } else {
                DOM.appContainer.classList.remove('shake-animation');
                AppState.isWarningState = false;
                hideWarnBanner();
            }

            if (finalGpa >= 3.00 && !AppState.hasCelebrated && isUserAction) {
                // (12) احتفال مخصص حسب التقدير: ذهبي للامتياز، فضي لجيد جداً
                triggerConfetti(finalGpa >= 3.69 ? 'gold' : 'silver');
                AppState.hasCelebrated = true;
            } else if (finalGpa < 3.00) {
                AppState.hasCelebrated = false;
            }
        } else {
            DOM.appContainer.classList.remove('shake-animation');
            AppState.isWarningState = false;
            AppState.hasCelebrated = false;
        }

        // تحديث مباشر بدون أي أنيميشن (تم إلغاء نبضة التقدير نهائياً)
        const ratingHtml = `<svg class="icon"><use href="#icon-award"/></svg> التّقدير: ${ratingText}`;
        if (DOM.gpaRating.innerHTML !== ratingHtml) DOM.gpaRating.innerHTML = ratingHtml;

        // إخفاء الرسالة إذا عاد المعدل فوق الحد دون عبور جديد
        if (finalTotalHours === 0 || finalGpa >= 2.00) hideWarnBanner();

    }

    // isUserAction: true إذا كان التعديل ناتجاً عن فعل مباشر من الطالب (لتحديث وقت الحفظ)
    function calculateGPA(isUserAction = false) {

        if (isUserAction) {
            AppState.currentTimestamp = new Date().getTime();
            AppState.lastSaveTime = new Date(AppState.currentTimestamp);
        }

        // ملاحظة: لا نُقصّ الساعات المقطوعة على سقف خطة التخصص هنا أبداً —
        // ذلك يُفسد نقاط المعدل التراكمي الحقيقية (المعدل × الساعات).
        // تضارب الأرقام (ساعات منجزة > خطة التخصص) يُعالج في updateProgressSection كتحذير فقط.
        const oldGpa = parseFloat(DOM.oldGpa.value) || 0;
        const oldHours = parseFloat(DOM.oldHours.value) || 0;

        let oldTotalPoints = oldGpa * oldHours;
        let finalTotalHours = oldHours; // إجمالي الساعات المُنجزة (تشمل مواد "ناجح" لأنها اجتياز فعلي)
        let gpaHours = oldHours;        // الساعات المُحتسبة ضمن معادلة المعدل فقط (تستثني "ناجح"/"راسب")
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
            gpaHistory: AppState.gpaHistory,
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

            // تُحسب ساعات الفصل للمواد المقيّمة فقط
            if (gradeInput !== '') registeredSemesterHours += hours;

            if (gradeInput === 'pass') {
                // "ناجح": تُضاف ساعاتها لإجمالي المُنجز فقط، ولا تدخل بمعادلة المعدل
                if (!isRepeated) finalTotalHours += hours;
            } else if (gradeInput === 'fail') {
                // "راسب" بدون علامة رقمية: لم تُنجز المادة، فلا تُضاف لا للساعات ولا للمعدل
            } else if (gradeInput !== "") {
                const gradeValue = parseFloat(gradeInput) || 0;
                const oldGradeValue = parseFloat(oldGradeInput) || 0;
                if (!isRepeated) {
                    finalTotalHours += hours;
                    gpaHours += hours;
                } else if (oldGradeValue <= 1.00) {
                    // المعادة بعلامة رسوب سابقة (-D / 1.00): الرسوب لم يُحتسب ضمن الساعات
                    // المقطوعة، فالنجاح في المحاولة الجديدة يضيف ساعاتها لإنجاز الخطة.
                    finalTotalHours += hours;
                    // ساعات المعدل تُضاف فقط إذا لم تكن هناك ساعات سابقة مسجلة إطلاقاً
                    // (لا محاولة سابقة ضمن النقاط => تُعامل كمادة جديدة تماماً في المعدل)
                    if (oldHours === 0) gpaHours += hours;
                }
                // إذا كانت العلامة السابقة (D) أو أعلى: لا يُضاف شيء للساعات المقطوعة
                newSemesterPoints += (hours * gradeValue);
                newSemesterHours += hours;
                if (isRepeated && oldHours > 0) {
                    // خصم نقاط المحاولة السابقة، مع منع النقاط التراكمية السالبة
                    oldTotalPoints = Math.max(0, oldTotalPoints - (hours * oldGradeValue));
                }
            }
        });

        const semesterGpa = newSemesterHours > 0 ? newSemesterPoints / newSemesterHours : 0;
        const finalTotalPoints = oldTotalPoints + newSemesterPoints;
        const finalGpa = gpaHours > 0 ? finalTotalPoints / gpaHours : 0;

        // تخزين النتائج الفعلية لاستخدامها في الترحيل بدل قراءة الأرقام أثناء أنيميشنها
        AppState.lastComputed = {
            gpa: finalGpa,
            hours: finalTotalHours,
            semHours: newSemesterHours
        };

        saveUserData(dataToSave);

        const currentGpa = parseFloat(DOM.resultGpa.innerText) || 0;
        const currentSemGpa = parseFloat(DOM.semesterGpaBadge.innerText.replace(/[^0-9.]/g, '')) || 0;
        const currentHours = parseInt(DOM.resultHours.innerText.replace(/[^0-9]/g, ''), 10) || 0;
        const currentRegHours = parseInt(DOM.semesterHoursBadge.innerText.replace(/[^0-9]/g, ''), 10) || 0;

        animateValue(DOM.resultGpa, currentGpa, finalGpa, 250, true, "");
        animateValue(DOM.semesterGpaBadge, currentSemGpa, semesterGpa, 250, true, `<svg class="icon"><use href="#icon-pie"/></svg> الفصلي: `);
        animateValue(DOM.resultHours, currentHours, finalTotalHours, 250, false, `<svg class="icon"><use href="#icon-clock"/></svg> مجموع الساعات: `);
        animateValue(DOM.semesterHoursBadge, currentRegHours, registeredSemesterHours, 250, false, `ساعات الفصل: `);

        updateProgressSection(finalTotalHours, gpaHours, finalGpa);
        checkAcademicWarnings(finalTotalHours, finalGpa, isUserAction);
        updateChart(oldGpa, finalGpa);
    }

    // ==========================================
    // 5. الرسم البياني والاحتفالات (Confetti)
    // ==========================================
    function updateChart(oldGpa, finalGpa) {
        let chartLabels = [];
        let chartData = [];

        // دمج كل المصادر زمنياً — لا تُحذف أي نقطة أبداً:
        // الإدخال اليدوي الأقدم ← سجل الترحيلات التلقائي ← الحالي ← الجديد.
        // النقاط المتطابقة قيمةً ومتجاورة فقط تُدمج (hist2 = آخر ترحيل مثلاً)
        // حتى لا يظهر نفس المعدل مرتين بصرياً.
        const pushPoint = (label, value, force = false) => {
            const v = parseFloat(value);
            if (isNaN(v)) return;
            const last = chartData[chartData.length - 1];
            if (!force && last !== undefined && Math.abs(last - v) < 0.005) return;
            chartLabels.push(label);
            chartData.push(v);
        };

        const h1 = parseFloat(DOM.hist1.value);
        const h2 = parseFloat(DOM.hist2.value);
        if (!isNaN(h1)) pushPoint('المعدل الأقدم', h1);
        if (!isNaN(h2)) pushPoint('المعدل السابق', h2);

        AppState.gpaHistory.forEach((g, i) => {
            const d = AppState.gpaHistory.length - i; // المسافة عن الفصل الحالي
            let label;
            if (d === 1) label = 'الفصل الماضي';
            else if (d === 2) label = 'منذ فصلين';
            else label = `منذ ${d} فصول`;
            pushPoint(label, g);
        });

        if (oldGpa > 0) pushPoint('المعدل الحالي', oldGpa);
        pushPoint('المعدل الجديد', finalGpa, true); // إلزامي: حتى لو ساوى الحالي

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

    // (12) احتفال مخصص حسب المستوى: gold (امتياز) / silver (جيد جداً)
    async function triggerConfetti(style = 'silver') {
        try { await loadConfettiLib(); } catch (e) { return; }
        const configs = {
            gold: { particleCount: 7, spread: 75, colors: ['#f3c300', '#ffd700', '#ffffff', '#006838'], duration: 3.5 },
            silver: { particleCount: 5, spread: 60, colors: ['#e2e8f0', '#ffffff', '#f3c300'], duration: 3 }
        };
        const cfg = configs[style] || configs.silver;
        const duration = cfg.duration * 1000;
        const end = Date.now() + duration;
        (function frame() {
            confetti({ particleCount: cfg.particleCount, angle: 60, spread: cfg.spread, origin: { x: 0 }, colors: cfg.colors });
            confetti({ particleCount: cfg.particleCount, angle: 120, spread: cfg.spread, origin: { x: 1 }, colors: cfg.colors });
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
