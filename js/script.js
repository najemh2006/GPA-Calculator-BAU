'use strict';

/*
 * حاسبة المعدل التراكمي — جامعة البلقاء التطبيقية
 */
(() => {

    // ==========================================
    // 1. الثوابت والبيانات
    // ==========================================
    const CONFIG = {
        STORAGE_KEY: 'bau_gpa_calculator_data',
        UNDO_MS: 5000,
        WARN_MS: 5000,
        SAVE_REFRESH_MS: 10000,
        CALC_DEBOUNCE_MS: 150,
        GRADE_MAX: 4,
        MIN_GPA: 2.00,
        MAX_COURSES: 12,
        DEFAULT_COURSES: 4,
        MAX_HISTORY: 6,
        MAX_TRACKED: 12,
        STABLE_DELTA: 0.10,
        SEMESTER_HOURS: 15
    };

    const Store = {
        get: (key) => { try { return localStorage.getItem(key); } catch(e) { return null; } },
        set: (key, val) => { try { localStorage.setItem(key, val); return true; } catch(e) { return false; } },
        remove: (key) => { try { localStorage.removeItem(key); } catch(e) {} }
    };

    const GRADES = [
        { v: '4.00', l: 'A' }, { v: '3.75', l: '-A' }, { v: '3.50', l: '+B' },
        { v: '3.25', l: '(B)' }, { v: '3.00', l: '(-B)' }, { v: '2.75', l: '(+C)' },
        { v: '2.50', l: '(C)' }, { v: '2.25', l: '(-C)' }, { v: '2.00', l: '(+D)' },
        { v: '1.25', l: '(D)' }, { v: '1.00', l: '(رسوب) (-D)' }
    ];

    const OLD_GRADE_SYSTEMS = {
        'new': [['2.50', '(C)'], ['2.25', '(-C)'], ['2.00', '(+D)'], ['1.25', '(D)'], ['1.00', '(رسوب) (-D)']],
        'old': [['2.00', 'C'], ['1.75', '-C'], ['1.50', '+D'], ['1.00', 'D'], ['0.75', '(رسوب) -D']]
    };

    const RATINGS = [
        [3.69, 'امتياز 🥇'], [3.00, 'جيد جداً 🥈'], [2.50, 'جيد 🥉'],
        [2.00, 'مقبول 👍'], [-Infinity, 'ضعيف ⚠️']
    ];

    const TIME_UNITS = [
        { secs: 86400, forms: ['يوم', 'يومين', 'أيام', 'يوم'] },
        { secs: 3600, forms: ['ساعة', 'ساعتين', 'ساعات', 'ساعة'] },
        { secs: 60, forms: ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة'] }
    ];

    const SVG_NS = 'http://www.w3.org/2000/svg';

    // ==========================================
    // 2. الحالة والعناصر
    // ==========================================
    const AppState = {
        chartInstance: null,
        hasCelebrated: false,
        isWarningState: false,
        confettiPromise: null,
        undoAction: null,
        gpaHistory: [],
        undoToastTimeout: null,
        undoInterval: null,
        undoCountReset: null,
        warnTimeout: null,
        lastSaveTime: null,
        timeUpdateInterval: null,
        lastChartDataString: '',
        currentTimestamp: null,
        lastComputed: { gpa: 0, hours: 0, semHours: 0 },
        lastFull: null,
        animFrames: new WeakMap()
    };

    const DOM = {};

    function cacheDOM() {
        const ids = [
            'gpaRating', 'oldGpa', 'oldHours', 'planTotal', 'planTarget', 'hist1', 'hist2',
            'coursesContainer', 'resultGpa', 'semesterGpaBadge', 'resultHours', 'semesterHoursBadge',
            'appContainer', 'progressPercent', 'progressFill', 'progressNote',
            'undoToast', 'undoMsg', 'undoTimerText', 'saveStatusText',
            'warnToast', 'warnMsg', 'detailsModal', 'detailsBody',
            'historyModal', 'historyList',
            'courseTemplate', 'noteTemplates', 'detailTemplates',
            'resetBtn', 'addCourseBtn', 'nextSemesterBtn', 'undoBtn', 'detailsBtn',
            'detailsCloseBtn', 'detailsBackdrop', 'historyBtn', 'historyCloseBtn',
            'historyBackdrop', 'historyAddBtn', 'historySaveBtn'
        ];
        ids.forEach(id => { DOM[id] = document.getElementById(id); });
    }

    // ==========================================
    // 3. أدوات مساعدة
    // ==========================================
    function debounce(fn, delay) {
        let id;
        return function (...args) {
            clearTimeout(id);
            id = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    function retriggerAnimation(el, className) {
        el.classList.remove(className);
        void el.offsetWidth;
        el.classList.add(className);
    }

    function pluralize(count, [one, two, few, many]) {
        if (count === 1) return one;
        if (count === 2) return two;
        return (count >= 3 && count <= 10) ? few : many;
    }

    const h = (tag, cls = '', ...kids) => {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        el.append(...kids);
        return el;
    };

    const icon = (id) => {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'icon');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `#${id}`);
        svg.append(use);
        return svg;
    };

    const fromTemplate = (tpl, selector) => tpl.content.querySelector(selector).cloneNode(true);

    const counter = (target, { prefix = '', float = true, cls = '' } = {}) => {
        const el = h('span', `d-val ${cls}`.trim(), prefix + (float ? '0.00' : '0'));
        el.dataset.target = target;
        el.dataset.prefix = prefix;
        el.dataset.float = float ? '2' : '0';
        return el;
    };

    function animateValue(obj, start, end, duration, isFloat = false, prefix = '', suffix = '') {
        const previous = AppState.animFrames.get(obj);
        if (previous) cancelAnimationFrame(previous);

        let startTs = null;
        const step = (ts) => {
            if (!startTs) startTs = ts;
            const progress = Math.min((ts - startTs) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const val = eased * (end - start) + start;
            const html = prefix + (isFloat ? val.toFixed(2) : Math.round(val)) + suffix;
            if (obj.innerHTML !== html) obj.innerHTML = html;

            if (progress < 1) {
                AppState.animFrames.set(obj, requestAnimationFrame(step));
            } else {
                obj.innerHTML = prefix + (isFloat ? end.toFixed(2) : Math.round(end)) + suffix;
                AppState.animFrames.delete(obj);
            }
        };
        AppState.animFrames.set(obj, requestAnimationFrame(step));
    }

    function formatGpaInput(event) {
        if (event.inputType && event.inputType.startsWith('delete')) return;
        const input = event.target;
        let raw = input.value.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632));
        const value = raw.replace(/[^0-9]/g, '');

        if (!value) { input.value = ''; return; }

        let first = value.charAt(0);
        if (parseInt(first, 10) > CONFIG.GRADE_MAX) first = String(CONFIG.GRADE_MAX);
        let decimals = value.substring(1, 3);
        if (first === String(CONFIG.GRADE_MAX) && decimals) decimals = decimals.replace(/[1-9]/g, '0');
        input.value = value.length === 1 ? `${first}.` : `${first}.${decimals}`;
    }

    // ==========================================
    // 4. التخزين ومؤشر الحفظ
    // ==========================================
    function updateSaveIndicator() {
        if (!AppState.lastSaveTime || !DOM.saveStatusText) return;
        const diff = Math.floor((Date.now() - AppState.lastSaveTime) / 1000);
        let text;
        if (diff < 10) text = 'الآن';
        else if (diff < 60) text = 'قبل ثوانٍ';
        else {
            const unit = TIME_UNITS.find(u => diff >= u.secs);
            const n = Math.floor(diff / unit.secs);
            text = `منذ ${n} ${pluralize(n, unit.forms)}`;
        }
        DOM.saveStatusText.textContent = `تم الحفظ: ${text}`;
    }

    function saveUserData(data) {
        const task = () => {
            Store.set(CONFIG.STORAGE_KEY, JSON.stringify(data));
            updateSaveIndicator();
        };
        if ('requestIdleCallback' in window) requestIdleCallback(task);
        else setTimeout(task, 50);
    }

    function stampNow() {
        AppState.currentTimestamp = Date.now();
        AppState.lastSaveTime = new Date(AppState.currentTimestamp);
    }

    function loadData() {
        const raw = Store.get(CONFIG.STORAGE_KEY);
        if (!raw) {
            stampNow();
            addDefaultCourses();
            initChart(['المعدل الحالي', 'المعدل الجديد'], [0, 0], 0, 4);
            calculateGPA(false);
            return;
        }

        try {
            const saved = JSON.parse(raw);
            if (saved.timestamp) {
                AppState.currentTimestamp = saved.timestamp;
                AppState.lastSaveTime = new Date(saved.timestamp);
            } else {
                stampNow();
            }
            updateSaveIndicator();

            AppState.gpaHistory = Array.isArray(saved.gpaHistory)
                ? saved.gpaHistory.map(parseFloat).filter(v => !isNaN(v) && v >= 0 && v <= CONFIG.GRADE_MAX)
                : [];

            const validGpa = (v) => v === '' || (!isNaN(parseFloat(v)) && parseFloat(v) >= 0 && parseFloat(v) <= CONFIG.GRADE_MAX);
            const validHours = (v) => v === '' || (!isNaN(parseInt(v, 10)) && parseInt(v, 10) >= 0);
            const pick = (v, ok) => (ok(v) ? (v || '') : '');

            DOM.oldGpa.value = pick(saved.oldGpa, validGpa);
            DOM.oldHours.value = pick(saved.oldHours, validHours);
            DOM.planTotal.value = pick(saved.planTotal, validHours);
            DOM.planTarget.value = pick(saved.planTarget, validGpa);
            DOM.hist1.value = pick(saved.hist1, validGpa);
            DOM.hist2.value = pick(saved.hist2, validGpa);

            if (Array.isArray(saved.courses) && saved.courses.length > 0) {
                renderCourses(saved.courses.map(c => ({
                    grade: c.grade || '',
                    hours: c.hours || '3',
                    isRepeated: !!c.isRepeated,
                    oldGrade: c.oldGrade || '1.00',
                    oldSystem: c.oldSystem || 'new'
                })));
            } else {
                addDefaultCourses();
            }
        } catch (error) {
            console.warn('تعذرت قراءة البيانات المحفوظة:', error);
            Store.remove(CONFIG.STORAGE_KEY);
            addDefaultCourses();
        }
        initChart(['المعدل الحالي', 'المعدل الجديد'], [0, 0], 0, 4);
        calculateGPA(false);
    }

    function resetCalculator() {
        if (!confirm('هل أنت متأكد من رغبتك في تفريغ جميع البيانات وحذف المواد الحالية؟')) return;
        AppState.gpaHistory = [];
        [DOM.oldGpa, DOM.oldHours, DOM.planTotal, DOM.planTarget, DOM.hist1, DOM.hist2].forEach(i => { i.value = ''; });
        addDefaultCourses();
        AppState.hasCelebrated = true;
        AppState.isWarningState = false;
        DOM.appContainer.classList.remove('shake-animation');
        calculateGPA(true);
        hideUndoToast();
    }

    function moveToNextSemester() {
        const computed = AppState.lastComputed;

        if (!computed || computed.semHours === 0) {
            alert('يرجى إدخال مواد وعلامات للفصل الحالي قبل الترحيل.');
            return;
        }

        const curGpa = parseFloat(DOM.oldGpa.value) || 0;
        const curHours = parseInt(DOM.oldHours.value, 10) || 0;
        if (Math.abs(computed.gpa - curGpa) < 0.005 && computed.hours === curHours) {
            alert('لا توجد نتائج جديدة للترحيل — أدخل مواد الفصل الحالي أولاً.');
            return;
        }

        if (!confirm('هل تريد ترحيل هذا المعدل ليكون معدلك الحالي، والبدء بفصل جديد؟')) return;

        const prevGpaVal = DOM.oldGpa.value;
        const prevHist2 = DOM.hist2.value;

        const snapshot = {
            oldGpa: prevGpaVal,
            oldHours: DOM.oldHours.value,
            hist1: DOM.hist1.value,
            hist2: prevHist2,
            gpaHistory: [...AppState.gpaHistory],
            hasCelebrated: AppState.hasCelebrated,
            courses: readAllCourses()
        };

        const prevNum = parseFloat(prevGpaVal);
        if (!isNaN(prevNum) && prevNum > 0) {
            AppState.gpaHistory.push(prevNum);
            if (AppState.gpaHistory.length > CONFIG.MAX_HISTORY) AppState.gpaHistory.shift();
        }

        if (prevGpaVal !== '' && prevGpaVal !== DOM.hist2.value) DOM.hist2.value = prevGpaVal;
        if (prevHist2 !== '' && prevHist2 !== DOM.hist1.value) DOM.hist1.value = prevHist2;

        DOM.oldGpa.value = computed.gpa.toFixed(2);
        DOM.oldHours.value = computed.hours;
        addDefaultCourses();
        AppState.hasCelebrated = computed.gpa >= 3.00;
        AppState.isWarningState = false;
        DOM.appContainer.classList.remove('shake-animation');
        calculateGPA(true);

        showUndoToast('تم ترحيل الفصل', () => {
            DOM.oldGpa.value = snapshot.oldGpa;
            DOM.oldHours.value = snapshot.oldHours;
            DOM.hist1.value = snapshot.hist1;
            DOM.hist2.value = snapshot.hist2;
            AppState.gpaHistory = [...snapshot.gpaHistory];
            AppState.hasCelebrated = snapshot.hasCelebrated;
            renderCourses(snapshot.courses);
            calculateGPA(true);
        });
    }

    // ==========================================
    // 5. المواد الدراسية
    // ==========================================
    function fillGradeSelect(select, isZeroHours, selected = '') {
        const opts = isZeroHours
            ? [['', 'اختر النتيجة'], ['pass', 'ناجح'], ['fail', 'راسب']]
            : [['', 'اختر العلامة'], ['pass', 'ناجح (لا تُحتسب بالمعدل)'], ...GRADES.map(g => [g.v, g.l])];

        select.replaceChildren(...opts.map(([value, text]) => {
            const option = new Option(text, value);
            option.disabled = value === '';
            return option;
        }));
        select.value = opts.some(([v]) => v === selected) ? selected : '';
    }

    function rebuildOldGradeSelect(card) {
        const useOld = card.querySelector('.old-weight-pill').classList.contains('active');
        const select = card.querySelector('.old-grade');
        const opts = OLD_GRADE_SYSTEMS[useOld ? 'old' : 'new'];
        const currentIdx = select.selectedIndex;

        select.replaceChildren(...opts.map(([v, l]) => new Option(l, v)));
        select.selectedIndex = Math.max(0, Math.min(currentIdx > -1 ? currentIdx : opts.length - 1, opts.length - 1));
    }

    function setSelectValue(select, value, fallback) {
        select.value = value;
        if (select.selectedIndex < 0) select.value = fallback;
    }

    function toggleRepeat(checkbox) {
        checkbox.closest('.course-options').querySelector('.old-grade-wrapper').classList.toggle('show', checkbox.checked);
        checkbox.closest('.course-card').classList.toggle('repeated', checkbox.checked);
    }

    function readCourse(card) {
        const hours = card.querySelector('.course-hours').value;
        return {
            hours,
            grade: card.querySelector('.course-grade').value,
            isRepeated: hours !== '0' && card.querySelector('.repeat-checkbox').checked,
            oldGrade: card.querySelector('.old-grade').value,
            oldSystem: card.querySelector('.old-weight-pill').classList.contains('active') ? 'old' : 'new'
        };
    }

    const readAllCourses = () => Array.from(DOM.coursesContainer.querySelectorAll('.course-card'), readCourse);

    function createCourseElement(course = null) {
        const card = DOM.courseTemplate.content.firstElementChild.cloneNode(true);
        const hours = course ? course.hours : '3';
        const isZero = hours === '0';
        const repeated = !!(course && course.isRepeated) && !isZero;

        setSelectValue(card.querySelector('.course-hours'), hours, '3');
        fillGradeSelect(card.querySelector('.course-grade'), isZero, course ? course.grade : '');

        const savedOld = course && course.oldGrade;
        const useOld = (course && course.oldSystem === 'old')
            || (!!savedOld && ['1.75', '1.50', '0.75'].includes(savedOld));

        const pill = card.querySelector('.old-weight-pill');
        pill.classList.toggle('active', useOld);
        pill.setAttribute('aria-pressed', String(useOld));
        rebuildOldGradeSelect(card);
        setSelectValue(card.querySelector('.old-grade'), savedOld || (useOld ? '0.75' : '1.00'), useOld ? '0.75' : '1.00');

        const repeatBox = card.querySelector('.repeat-checkbox');
        repeatBox.checked = repeated;
        toggleRepeat(repeatBox);
        card.querySelector('.checkbox-label').hidden = isZero;
        return card;
    }

    function renderCourses(list) {
        DOM.coursesContainer.replaceChildren(...list.map(createCourseElement));
        updateCourseNumbers();
    }

    function addDefaultCourses() {
        renderCourses(Array.from({ length: CONFIG.DEFAULT_COURSES }, () => null));
    }

    function updateCourseNumbers() {
        DOM.coursesContainer.querySelectorAll('.course-card').forEach((card, i) => {
            card.querySelector('.course-number').textContent = i + 1;
        });
    }

    function addCourse() {
        if (DOM.coursesContainer.querySelectorAll('.course-card').length >= CONFIG.MAX_COURSES) {
            alert(`لا يمكن إضافة أكثر من ${CONFIG.MAX_COURSES} مادة في الفصل الواحد.`);
            return;
        }
        DOM.coursesContainer.appendChild(createCourseElement());
        updateCourseNumbers();
        calculateGPA(true);
    }

    function removeCourse(button) {
        const card = button.closest('.course-card');
        const cards = Array.from(DOM.coursesContainer.querySelectorAll('.course-card:not(.removing)'));

        if (cards.length <= 1 || card.classList.contains('removing')) {
            alert('يجب إبقاء مادة واحدة على الأقل في الجدول.');
            return;
        }

        const allCards = Array.from(DOM.coursesContainer.querySelectorAll('.course-card'));
        const deleted = { ...readCourse(card), index: allCards.indexOf(card) };
        card.classList.add('removing');

        setTimeout(() => {
            card.remove();
            updateCourseNumbers();
            debouncedCalculateAndSave();
            showUndoToast('تم حذف المادة', () => {
                const restored = createCourseElement(deleted);
                const ref = DOM.coursesContainer.children[deleted.index];
                DOM.coursesContainer.insertBefore(restored, ref || null);
                updateCourseNumbers();
                calculateGPA(true);
            });
        }, 250);
    }

    function onHoursChange(select) {
        const card = select.closest('.course-card');
        const gradeSelect = card.querySelector('.course-grade');
        const repeatLabel = card.querySelector('.checkbox-label');
        const repeatBox = card.querySelector('.repeat-checkbox');
        const isZero = select.value === '0';

        if (gradeSelect.dataset.zero !== String(isZero)) {
            fillGradeSelect(gradeSelect, isZero, gradeSelect.value);
            gradeSelect.dataset.zero = isZero;
        }

        repeatLabel.hidden = isZero;
        if (isZero && repeatBox.checked) {
            repeatBox.checked = false;
            toggleRepeat(repeatBox);
        }
        retriggerAnimation(gradeSelect, 'select-pulse');
    }

    // ==========================================
    // 6. الإشعارات (تراجع / تحذير)
    // ==========================================
    function showUndoToast(message, action) {
        const toast = DOM.undoToast;
        DOM.undoMsg.textContent = message;
        AppState.undoAction = action;
        toast.classList.add('show');

        clearTimeout(AppState.undoCountReset);
        toast.classList.remove('is-counting');
        void toast.offsetWidth;
        toast.classList.add('is-counting');

        let left = CONFIG.UNDO_MS / 1000;
        DOM.undoTimerText.textContent = left;
        clearInterval(AppState.undoInterval);
        AppState.undoInterval = setInterval(() => {
            left--;
            if (left > 0) DOM.undoTimerText.textContent = left;
        }, 1000);

        clearTimeout(AppState.undoToastTimeout);
        AppState.undoToastTimeout = setTimeout(hideUndoToast, CONFIG.UNDO_MS);
    }

    function hideUndoToast() {
        DOM.undoToast.classList.remove('show');
        AppState.undoAction = null;
        clearInterval(AppState.undoInterval);
        clearTimeout(AppState.undoCountReset);
        AppState.undoCountReset = setTimeout(() => DOM.undoToast.classList.remove('is-counting'), 400);
    }

    function undoDelete() {
        if (!AppState.undoAction) return;
        const action = AppState.undoAction;
        clearTimeout(AppState.undoToastTimeout);
        hideUndoToast();
        action();
    }

    function showWarnBanner(message) {
        const toast = DOM.warnToast;
        DOM.warnMsg.textContent = message;
        toast.classList.remove('hide', 'show');
        void toast.offsetWidth;
        toast.classList.add('show');
        clearTimeout(AppState.warnTimeout);
        AppState.warnTimeout = setTimeout(hideWarnBanner, CONFIG.WARN_MS);
    }

    function hideWarnBanner() {
        DOM.warnToast.classList.remove('show');
        DOM.warnToast.classList.add('hide');
        clearTimeout(AppState.warnTimeout);
        AppState.warnTimeout = null;
    }

    // ==========================================
    // 7. الحساب النقي
    // ==========================================
    function computeGPA(oldGpa, oldHours, courses) {
        let oldTotalPoints = oldGpa * oldHours;
        let finalTotalHours = oldHours;
        let gpaHours = oldHours;
        let newSemesterPoints = 0;
        let newSemesterHours = 0;
        let registeredSemesterHours = 0;

        courses.forEach(c => {
            const { hours, grade } = c;
            if (grade !== '') registeredSemesterHours += hours;

            if (grade === 'pass') {
                if (!c.isRepeated) finalTotalHours += hours;
            } else if (grade !== '' && grade !== 'fail') {
                const gradeValue = parseFloat(grade) || 0;
                const oldGradeValue = parseFloat(c.oldGrade) || 0;
                if (!c.isRepeated || oldHours === 0) {
                    finalTotalHours += hours;
                    gpaHours += hours;
                }
                newSemesterPoints += hours * gradeValue;
                newSemesterHours += hours;
                if (c.isRepeated && oldHours > 0) {
                    oldTotalPoints = Math.max(0, oldTotalPoints - hours * oldGradeValue);
                }
            }
        });

        const finalTotalPoints = oldTotalPoints + newSemesterPoints;
        return {
            semesterGpa: newSemesterHours > 0 ? newSemesterPoints / newSemesterHours : 0,
            finalGpa: gpaHours > 0 ? finalTotalPoints / gpaHours : 0,
            finalTotalHours,
            gpaHours,
            newSemesterHours,
            registeredSemesterHours
        };
    }

    function calculateGPA(isUserAction = false) {
        try {
            calculateGPACore(isUserAction);
        } catch (err) {
            console.error('خطأ أثناء الحساب:', err);
        }
    }

    function calculateGPACore(isUserAction) {
        if (isUserAction) stampNow();

        const oldGpa = parseFloat(DOM.oldGpa.value) || 0;
        const oldHours = parseFloat(DOM.oldHours.value) || 0;

        const rawCourses = readAllCourses();
        saveUserData({
            oldGpa: DOM.oldGpa.value,
            oldHours: DOM.oldHours.value,
            planTotal: DOM.planTotal.value,
            planTarget: DOM.planTarget.value,
            hist1: DOM.hist1.value,
            hist2: DOM.hist2.value,
            timestamp: AppState.currentTimestamp,
            gpaHistory: AppState.gpaHistory,
            courses: rawCourses
        });

        const coursesInput = rawCourses.map(c => ({ ...c, hours: parseFloat(c.hours) || 0 }));
        const result = computeGPA(oldGpa, oldHours, coursesInput);
        const { semesterGpa, finalGpa, finalTotalHours, gpaHours, newSemesterHours } = result;

        AppState.lastComputed = { gpa: finalGpa, hours: finalTotalHours, semHours: newSemesterHours };
        AppState.lastFull = { oldGpa, oldHours, finalGpa, gpaHours, finalTotalHours, semesterGpa, newSemHours: newSemesterHours, courses: coursesInput };

        renderResults(result);
        updateProgressSection(finalTotalHours, gpaHours, finalGpa);
        checkAcademicWarnings(finalTotalHours, gpaHours, finalGpa, isUserAction, newSemesterHours);
        updateChart(oldGpa, finalGpa);
    }

    // ==========================================
    // 8. عرض النتائج والتقدم والتحذيرات
    // ==========================================
    const readNumber = (el) => parseFloat(el.textContent.replace(/[^0-9.]/g, '')) || 0;

    function renderResults({ finalGpa, semesterGpa, finalTotalHours, registeredSemesterHours }) {
        animateValue(DOM.resultGpa, readNumber(DOM.resultGpa), finalGpa, 250, true);
        animateValue(DOM.semesterGpaBadge, readNumber(DOM.semesterGpaBadge), semesterGpa, 250, true, '<svg class="icon"><use href="#icon-pie"/></svg> المعدل الفصلي: ');
        animateValue(DOM.resultHours, readNumber(DOM.resultHours), finalTotalHours, 250, false, '<svg class="icon"><use href="#icon-clock"/></svg> مجموع السّاعات: ');
        animateValue(DOM.semesterHoursBadge, readNumber(DOM.semesterHoursBadge), registeredSemesterHours, 250, false, 'ساعات الفصل: ');
    }

    const NoteAnim = { key: 'idle' };

    function setNote(key, values = [], isFloat = []) {
        const note = DOM.progressNote;

        if (NoteAnim.key === key) {
            const spans = note.querySelectorAll('.note-val');
            values.forEach((v, i) => {
                const span = spans[i];
                if (!span) return;
                const current = parseFloat(span.textContent) || 0;
                if (current !== v) animateValue(span, current, v, 600, !!isFloat[i]);
            });
            return;
        }

        NoteAnim.key = key;
        note.replaceChildren(fromTemplate(DOM.noteTemplates, `[data-note="${key}"]`));
        note.querySelectorAll('.note-val').forEach((span, i) => {
            span.textContent = isFloat[i] ? values[i].toFixed(2) : String(Math.round(values[i]));
        });
        retriggerAnimation(note, 'text-fade');
    }

    function setProgress(percentage) {
        DOM.progressFill.style.setProperty('--progress', `${percentage}%`);
        const current = parseFloat(DOM.progressPercent.textContent) || 0;
        if (current !== percentage) animateValue(DOM.progressPercent, current, percentage, 600, false, '', '%');
    }

    function updateProgressSection(finalTotalHours, gpaHours, finalGpa) {
        const planTotal = parseFloat(DOM.planTotal.value) || 0;
        const planTarget = parseFloat(DOM.planTarget.value) || 0;

        const inconsistent = planTotal > 0 && finalTotalHours > planTotal;
        DOM.planTotal.classList.toggle('is-invalid', inconsistent);

        if (inconsistent) {
            setProgress(100);
            setNote('plan-warning', [finalTotalHours, planTotal]);
            return;
        }

        if (!(planTotal > 0 && finalTotalHours > 0)) {
            setProgress(0);
            setNote('idle');
            return;
        }

        setProgress(Math.min(100, Math.round((finalTotalHours / planTotal) * 100)));

        if (!(planTarget > 0)) {
            setNote('hours-progress', [finalTotalHours, planTotal]);
            return;
        }

        const remaining = planTotal - finalTotalHours;
        if (remaining <= 0) {
            setNote(finalGpa >= planTarget ? 'done' : 'done-missed');
            return;
        }

        const countedPlan = planTotal - (finalTotalHours - gpaHours);
        const gpaRemaining = countedPlan - gpaHours;
        const requiredGpa = gpaRemaining > 0 ? (countedPlan * planTarget - gpaHours * finalGpa) / gpaRemaining : 0;

        if (requiredGpa > CONFIG.GRADE_MAX) setNote('impossible');
        else if (requiredGpa <= 0) setNote('secured');
        else setNote('need', [requiredGpa, remaining], [true, false]);
    }

    function checkAcademicWarnings(finalTotalHours, gpaHours, finalGpa, isUserAction, newSemesterHours) {
        let ratingText = '-';

        if (gpaHours > 0) {
            ratingText = RATINGS.find(([min]) => finalGpa >= min)[1];

            if (finalGpa < CONFIG.MIN_GPA) {
                if (isUserAction && !AppState.isWarningState) {
                    retriggerAnimation(DOM.appContainer, 'shake-animation');
                    AppState.isWarningState = true;
                    showWarnBanner(`معدلك التراكمي ${finalGpa.toFixed(2)} تحت الحد الأدنى (${CONFIG.MIN_GPA.toFixed(2)})`);
                }
            } else {
                DOM.appContainer.classList.remove('shake-animation');
                AppState.isWarningState = false;
            }

            if (finalGpa >= 3.00 && !AppState.hasCelebrated && isUserAction && newSemesterHours > 0) {
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

        const ratingHtml = `<svg class="icon"><use href="#icon-award"/></svg> التّقدير: ${ratingText}`;
        if (DOM.gpaRating.innerHTML !== ratingHtml) DOM.gpaRating.innerHTML = ratingHtml;

        if (finalTotalHours === 0 || finalGpa >= CONFIG.MIN_GPA) hideWarnBanner();
    }

    // ==========================================
    // 9. نافذة التفاصيل والمحاكاة الجديدة
    // ==========================================
    function openModal(modal) {
        modal.classList.remove('closing');
        modal.hidden = false;
        void modal.offsetWidth;
        modal.classList.add('open');
    }

    function closeModal(modal) {
        if (modal.hidden || modal.classList.contains('closing')) return;
        modal.classList.remove('open');
        modal.classList.add('closing');
        modal.querySelector('.bau-modal-card').addEventListener('animationend', (e) => {
            if (e.target !== e.currentTarget) return;
            modal.hidden = true;
            modal.classList.remove('closing');
        }, { once: true });
    }

    function buildDetailsContent() {
        const body = DOM.detailsBody;
        const f = AppState.lastFull || {};
        const H = f.gpaHours || 0;
        const doneH = f.finalTotalHours || 0;
        const hasGpa = H > 0;
        const G = f.finalGpa || 0;
        const planTotal = parseFloat(DOM.planTotal.value) || 0;
        const tpl = (name) => fromTemplate(DOM.detailTemplates, `[data-tpl="${name}"]`);

        if (!doneH) {
            body.replaceChildren(tpl('empty-no-data'));
            return;
        }

        let order = 0;
        const item = (iconId, label, ...kids) => {
            const el = h('div', 'detail-item', h('div', 'detail-label', icon(iconId), ` ${label}`), ...kids);
            el.style.setProperty('--i', ++order);
            return el;
        };
        const row = (cls, ...kids) => h('div', `effect-row ${cls}`.trim(), ...kids);
        const span = (cls, ...kids) => h('span', cls, ...kids);

        const parts = [];

        if (planTotal > 0 && planTotal >= doneH) {
            const remainPlan = planTotal - doneH;
            const completion = Math.round((doneH / planTotal) * 100);
            
            if (!hasGpa) {
                const passBar = h('div', 'stab-hero-bar', h('span'));
                passBar.style.setProperty('--pct', `${completion}%`);
                parts.push(item('icon-cap', 'إنجاز خطة تخصصك',
                    h('div', 'stab-hero',
                        h('div', 'stab-hero-top',
                            h('div', 'stab-hero-num', counter(doneH, { float: false }), ' ', h('small', '', `من ${planTotal} ساعة (${completion}%)`)),
                            h('span', 'stab-hero-state ok', '✅ ساعات منجزة')),
                        passBar,
                        h('div', 'stab-hero-cap', 'موادك "ناجح" لا تُحتسب بالمعدل — أدخل مواداً مقيّمة بعلامات لتفعيل تحليل الاستقرار'))));
            }

            if (hasGpa) {
                const dMax = ((4 - G) * remainPlan) / planTotal;
                const stable = dMax <= CONFIG.STABLE_DELTA;

                // صف نقطة التعادل الذي يعرض المعدل المطلوب لرفع التراكمي
                const breakEvenRow = row('', span('', 'يجب الحصول على معدل'), counter(G, { cls: 'tone-primary' }), span('', 'فصلياً لاستقرار معدلك'));

                if (stable) {
                    parts.push(item('icon-clock', 'متى يستقر معدلي؟',
                        row('effect-row--ok', span('', '✅ معدلك مستقر الآن فعلاً'), span('tone-primary', `سقف تحسنه ≤ ${CONFIG.STABLE_DELTA.toFixed(2)}`)),
                        breakEvenRow
                    ));
                } else {
                    const stableAt = Math.ceil(planTotal * (1 - CONFIG.STABLE_DELTA / (4 - G)));
                    const remainStable = Math.max(0, stableAt - H);
                    const semesters = Math.ceil(remainStable / CONFIG.SEMESTER_HOURS);
                    const semText = semesters > 0 ? ` (~${semesters} ${semesters === 1 ? 'فصل' : 'فصول'})` : '';
                    parts.push(item('icon-clock', 'متى يستقر معدلك ؟',
                        row('', span('', 'يستقر عند'), span('', counter(stableAt, { float: false }), ' ساعة محتسبة')),
                        row('', span('', 'على بعد'), span('', counter(remainStable, { float: false }), ` ساعة إضافية${semText}`)),
                        breakEvenRow
                    ));
                }
            }
        } else {
            parts.push(item('icon-cap', 'تحليل الاستقرار', tpl('empty-no-plan')));
        }

        if (f.oldHours > 0 && f.newSemHours > 0) {
            const impact = G - f.oldGpa;
            const abs = Math.abs(impact);
            const [tone, label] = abs >= 0.15 ? ['strong', '⚡ تأثير كبير']
                : abs >= 0.05 ? ['medium', 'تأثير متوسط']
                : ['light', '🪶 تأثير بسيط'];
            parts.push(item('icon-history', 'أثر ما أدخلته الآن',
                row(`effect-row--${tone}`,
                    span('', 'الفرق على تراكميك'),
                    counter(impact, { prefix: impact >= 0 ? '+' : '', cls: `d-val--lg ${impact >= 0 ? 'is-up' : 'is-down'}` }),
                    span(`tone-${tone}`, label))));
        }

        const hist = (AppState.gpaHistory || []).filter(v => !isNaN(v));
        if (hist.length >= 2) {
            const n = hist.length;
            const firstV = hist[0], lastV = hist[n - 1];
            const rate = (lastV - firstV) / (n - 1);
            const maxV = Math.max(...hist), minV = Math.min(...hist);
            const labelFor = (i) => {
                const d = n - i;
                return d === 1 ? 'الفصل الماضي' : d === 2 ? 'منذ فصلين' : `منذ ${d} فصول`;
            };

            const recentHist = hist.slice(-3);
            const swing = Math.max(...recentHist) - Math.min(...recentHist);

            const [tone, toneLabel] = swing <= 0.15 ? ['ok', 'أداء مستقر']
                : swing <= 0.35 ? ['medium', 'تذبذب متوسط']
                : ['strong', 'أداء متقلب'];

            const rows = [
                row('', span('', 'متوسط تغيّرك/فصل'), counter(rate, { prefix: rate >= 0 ? '+' : '', cls: rate >= 0 ? 'is-up' : 'is-down' })),
                row('', span('', `أعلى معدل (${labelFor(hist.indexOf(maxV))})`), span('', maxV.toFixed(2))),
                row('', span('', `أدنى معدل (${labelFor(hist.indexOf(minV))})`), span('', minV.toFixed(2))),
                row(`effect-row--${tone}`, span('', 'مدى التذبذب (آخر 3 فصول)'), span(`tone-${tone}`, `${swing.toFixed(2)} · ${toneLabel}`))
            ];

            parts.push(item('icon-cap', `تحليل آدائك عبر ${n} ${pluralize(n, ['فصل', 'فصلين', 'فصول', 'فصل'])}`, ...rows));
        }

        // محاكاة الساعات الديناميكية المضافة جديداً
        if (hasGpa) {
            const calcEff = (g, hrs) => (hrs * (g - G)) / (H + hrs);
            
            const hrsSelect = h('select', 'sim-select');
            [1, 2, 3, 4, 5, 6].forEach(val => {
                hrsSelect.append(new Option(`${val} ${val <= 2 ? 'ساعة' : 'ساعات'}`, val));
            });
            hrsSelect.value = '3'; 

            const bestVal = counter(calcEff(4, 3), { prefix: '+', cls: 'is-up' });
            const worstVal = counter(calcEff(1, 3), { cls: 'is-down' });

            hrsSelect.addEventListener('change', (e) => {
                const hrs = parseInt(e.target.value, 10);
                animateValue(bestVal, parseFloat(bestVal.textContent) || 0, calcEff(4, hrs), 300, true, '+');
                animateValue(worstVal, parseFloat(worstVal.textContent) || 0, calcEff(1, hrs), 300, true, '');
            });

            parts.push(item('icon-book', 'محاكاة إضافة مادة جديدة',
                row('', span('', 'اختر عدد الساعات:'), hrsSelect),
                row('', span('grade-tag grade-tag--best', 'A كاملة'), span('', 'ستغيّر تراكميك'), bestVal),
                row('', span('grade-tag grade-tag--worst', 'رسوب (-D)'), span('', 'ستغيّر تراكميك'), worstVal)
            ));
        }

        const rule = tpl('rule');
        rule.querySelector('.rule-delta').textContent = CONFIG.STABLE_DELTA.toFixed(2);
        rule.classList.add('detail-item');
        rule.style.setProperty('--i', ++order);
        parts.push(rule);

        body.replaceChildren(...parts);
    }

    function animateDetailVals() {
        DOM.detailsBody.querySelectorAll('.d-val').forEach(el => {
            animateValue(el, 0, parseFloat(el.dataset.target) || 0, 700, el.dataset.float !== '0', el.dataset.prefix || '');
        });
    }

    // ==========================================
    // 9ب. نافذة "إضافة جميع الفصول"
    // ==========================================
    function createHistoryRow(value = '') {
        const input = h('input', 'hist-input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.dataset.gpa = '';
        input.setAttribute('aria-label', 'معدل تراكمي سابق');
        input.value = value;

        const del = h('button', 'btn-icon hist-del', icon('icon-trash'));
        del.type = 'button';
        del.setAttribute('aria-label', 'حذف هذا المعدل');

        return h('div', 'hist-row', h('span', 'hist-num'), input, del);
    }

    function updateHistoryNumbers() {
        DOM.historyList.querySelectorAll('.hist-row').forEach((rowEl, i) => {
            rowEl.querySelector('.hist-num').textContent = i + 1;
        });
    }

    function addHistoryRow(value = '') {
        if (DOM.historyList.querySelectorAll('.hist-row').length >= CONFIG.MAX_TRACKED) {
            alert(`لا يمكن إضافة أكثر من ${CONFIG.MAX_TRACKED} معدلاً في التتبع.`);
            return;
        }
        const rowEl = createHistoryRow(value);
        DOM.historyList.appendChild(rowEl);
        updateHistoryNumbers();
        rowEl.querySelector('input').focus();
    }

    function removeHistoryRow(button) {
        const rows = DOM.historyList.querySelectorAll('.hist-row');
        if (rows.length <= 1) {
            rows[0].querySelector('input').value = '';
            return;
        }
        button.closest('.hist-row').remove();
        updateHistoryNumbers();
    }

    function saveHistoryModal() {
        const values = Array.from(DOM.historyList.querySelectorAll('.hist-input'))
            .map(i => parseFloat(i.value))
            .filter(v => !isNaN(v) && v >= 0 && v <= CONFIG.GRADE_MAX);

        AppState.gpaHistory = values.slice(-CONFIG.MAX_TRACKED);

        const n = AppState.gpaHistory.length;
        DOM.hist1.value = n >= 2 ? AppState.gpaHistory[n - 2].toFixed(2) : '';
        DOM.hist2.value = n >= 1 ? AppState.gpaHistory[n - 1].toFixed(2) : '';

        closeModal(DOM.historyModal);
        calculateGPA(true);
    }

    // ==========================================
    // 10. الرسم البياني والاحتفال
    // ==========================================
    function updateChart(oldGpa, finalGpa) {
        try {
            const h1 = parseFloat(DOM.hist1.value);
            const h2 = parseFloat(DOM.hist2.value);

            let historyArray = Array.isArray(AppState.gpaHistory) ? [...AppState.gpaHistory] : [];
            let mergedHistory = [...historyArray];

            if (!isNaN(h2)) {
                if (mergedHistory.length >= 1) mergedHistory[mergedHistory.length - 1] = h2;
                else mergedHistory.push(h2);
            }
            if (!isNaN(h1)) {
                if (mergedHistory.length >= 2) mergedHistory[mergedHistory.length - 2] = h1;
                else if (mergedHistory.length === 1) mergedHistory.unshift(h1);
                else if (mergedHistory.length === 0) { mergedHistory.push(h1); if (!isNaN(h2)) mergedHistory.push(h2); }
            }

            while (mergedHistory.length > CONFIG.MAX_TRACKED) mergedHistory.shift();

            let timeline = [];
            mergedHistory.forEach((g, i) => {
                const d = mergedHistory.length - i;
                timeline.push({ label: d === 1 ? 'الفصل الماضي' : d === 2 ? 'منذ فصلين' : `منذ ${d} فصول`, val: g });
            });

            if (oldGpa > 0 && !isNaN(oldGpa)) timeline.push({ label: 'المعدل الحالي', val: oldGpa });
            if (!isNaN(finalGpa)) timeline.push({ label: 'المعدل الجديد', val: finalGpa });

            const labels = [];
            const data = [];
            timeline.forEach((pt, i) => {
                const v = parseFloat(pt.val);
                if (isNaN(v)) return;
                const last = data[data.length - 1];
                if (i === timeline.length - 1 || last === undefined || Math.abs(last - v) >= 0.005) {
                    labels.push(pt.label);
                    data.push(v);
                }
            });

            const signature = JSON.stringify({ labels, data });
            if (AppState.lastChartDataString === signature) return;
            AppState.lastChartDataString = signature;

            const yMin = Math.max(0, Math.min(...data) - 0.15);
            const yMax = Math.min(4.0, Math.max(...data) + 0.15);
            initChart(labels, data, yMin, yMax);

        } catch (error) {
            console.error("تم احتواء خطأ في رسم المنحنى:", error);
        }
    }

    function initChart(labels, data, yMin, yMax) {
        const canvas = document.getElementById('gpaChart');
        if (!canvas || typeof Chart === 'undefined') return;

        if (AppState.chartInstance) {
            const chart = AppState.chartInstance;
            chart.data.labels = labels;
            chart.data.datasets[0].data = data;
            chart.options.scales.y.min = yMin;
            chart.options.scales.y.max = yMax;
            chart.update();
            return;
        }

        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 350);
        gradient.addColorStop(0, 'rgba(243, 195, 0, 0.5)');
        gradient.addColorStop(1, 'rgba(243, 195, 0, 0.0)');

        AppState.chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'المعدل', data, borderColor: '#f3c300', backgroundColor: gradient,
                    borderWidth: 4, pointBackgroundColor: '#ffffff', pointBorderColor: '#f3c300',
                    pointBorderWidth: 3, pointRadius: 6, pointHoverRadius: 9, fill: true, tension: 0.4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: { duration: 300, easing: 'easeOutQuart' },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' المعدل: ' + c.parsed.y } } },
                scales: {
                    y: { min: yMin, max: yMax, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 14 } } },
                    x: { grid: { display: false }, ticks: { color: 'rgba(255, 255, 255, 0.9)', font: { family: 'Tajawal', size: 13 } } }
                }
            }
        });
    }

    function loadConfettiLib() {
        if (window.confetti) return Promise.resolve();
        if (!AppState.confettiPromise) {
            AppState.confettiPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }
        return AppState.confettiPromise;
    }

    async function triggerConfetti(style = 'silver') {
        try { await loadConfettiLib(); } catch (e) { return; }
        const configs = {
            gold: { particleCount: 7, spread: 75, colors: ['#f3c300', '#ffd700', '#ffffff', '#006838'], duration: 3.5 },
            silver: { particleCount: 5, spread: 60, colors: ['#e2e8f0', '#ffffff', '#f3c300'], duration: 3 }
        };
        const cfg = configs[style] || configs.silver;
        const end = Date.now() + cfg.duration * 1000;
        (function frame() {
            confetti({ particleCount: cfg.particleCount, angle: 60, spread: cfg.spread, origin: { x: 0 }, colors: cfg.colors });
            confetti({ particleCount: cfg.particleCount, angle: 120, spread: cfg.spread, origin: { x: 1 }, colors: cfg.colors });
            if (Date.now() < end) requestAnimationFrame(frame);
        }());
    }

    // ==========================================
    // 11. الأحداث والتشغيل
    // ==========================================
    const debouncedCalculateAndSave = debounce(() => calculateGPA(true), CONFIG.CALC_DEBOUNCE_MS);

    function bindEvents() {
        DOM.coursesContainer.addEventListener('click', (e) => {
            const del = e.target.closest('.delete-btn');
            if (del) { removeCourse(del); return; }
            const pill = e.target.closest('.old-weight-pill');
            if (pill) {
                const card = pill.closest('.course-card');
                const active = pill.classList.toggle('active');
                pill.setAttribute('aria-pressed', String(active));
                rebuildOldGradeSelect(card);
                debouncedCalculateAndSave();
            }
        });

        DOM.coursesContainer.addEventListener('change', (e) => {
            const t = e.target;
            if (t.classList.contains('repeat-checkbox')) toggleRepeat(t);
            else if (t.classList.contains('course-hours')) onHoursChange(t);
        });

        DOM.appContainer.addEventListener('input', (e) => {
            const t = e.target;
            if (t.matches('[data-gpa]')) formatGpaInput(e);
            else if (t.matches('[data-max]') && Number(t.value) > Number(t.dataset.max)) t.value = t.dataset.max;
            debouncedCalculateAndSave();
        });

        DOM.resetBtn.addEventListener('click', resetCalculator);
        DOM.addCourseBtn.addEventListener('click', addCourse);
        DOM.nextSemesterBtn.addEventListener('click', moveToNextSemester);
        DOM.undoBtn.addEventListener('click', undoDelete);
        
        DOM.detailsBtn.addEventListener('click', () => {
            buildDetailsContent();
            openModal(DOM.detailsModal);
            DOM.detailsModal.querySelector('.bau-modal-card').addEventListener('animationend', animateDetailVals, { once: true });
        });
        DOM.detailsCloseBtn.addEventListener('click', () => closeModal(DOM.detailsModal));
        DOM.detailsBackdrop.addEventListener('click', () => closeModal(DOM.detailsModal));

        DOM.historyBtn.addEventListener('click', () => {
            const values = (AppState.gpaHistory || []).map(v => Number(v).toFixed(2));
            DOM.historyList.replaceChildren(...(values.length ? values : ['']).map(createHistoryRow));
            updateHistoryNumbers();
            openModal(DOM.historyModal);
        });
        DOM.historyCloseBtn.addEventListener('click', () => closeModal(DOM.historyModal));
        DOM.historyBackdrop.addEventListener('click', () => closeModal(DOM.historyModal));
        DOM.historyAddBtn.addEventListener('click', () => addHistoryRow());
        DOM.historySaveBtn.addEventListener('click', saveHistoryModal);

        DOM.historyModal.addEventListener('click', (e) => {
            const del = e.target.closest('.hist-del');
            if (del) removeHistoryRow(del);
        });

        DOM.historyModal.addEventListener('input', (e) => {
            if (e.target.matches('[data-gpa]')) formatGpaInput(e);
        });

        DOM.historyModal.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('input')) saveHistoryModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeModal(DOM.detailsModal); closeModal(DOM.historyModal); }
        });
    }

    window.addEventListener('DOMContentLoaded', () => {
        cacheDOM();

        const root = document.documentElement.style;
        root.setProperty('--undo-duration', `${CONFIG.UNDO_MS}ms`);
        root.setProperty('--warn-duration', `${CONFIG.WARN_MS}ms`);

        bindEvents();
        loadData();

        clearInterval(AppState.timeUpdateInterval);
        AppState.timeUpdateInterval = setInterval(updateSaveIndicator, CONFIG.SAVE_REFRESH_MS);
    });

})();
