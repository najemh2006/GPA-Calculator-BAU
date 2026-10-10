'use strict';

/*
 * حاسبة المعدل التراكمي — جامعة البلقاء التطبيقية
 * -----------------------------------------------
 * تقسيم المسؤوليات:
 *   index.html : الهيكل (وقوالب <template> التي تُستنسخ هنا)
 *   style.css  : كل التنسيق والحركات (keyframes) وحالات العرض
 *   script.js  : السلوك فقط — يبدّل الكلاسات ويضبط متغيرات CSS ويملأ البيانات
 *
 * الأقسام:
 *   1. الثوابت والبيانات   2. الحالة والعناصر   3. أدوات مساعدة
 *   4. التخزين والحفظ      5. المواد الدراسية   6. الإشعارات (تراجع/تحذير)
 *   7. الحساب النقي        8. عرض النتائج       9. نافذة التفاصيل
 *  10. الرسم البياني والاحتفال   11. الأحداث والتشغيل
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
        MIN_GPA: 2.00,            // الحد الأدنى للمعدل
        MAX_COURSES: 12,          // أقصى عدد مواد منطقي في الفصل
        DEFAULT_COURSES: 4,
        MAX_HISTORY: 6,           // أقصى عدد فصول يُحفظ من الترحيل التلقائي
        MAX_TRACKED: 12,          // أقصى عدد فصول في نافذة تتبع التطور اليدوية
        STABLE_DELTA: 0.10,       // عتبة الاستقرار: سقف التحسن المتبقي
        REPEAT_GREAT: 0.10,       // ربحية إعادة المادة: ممتازة لرفع المعدل
        REPEAT_WORTH: 0.05,       // ربحية إعادة المادة: مجدية
        SEMESTER_HOURS: 15        // تقدير الساعات في الفصل (لنافذة التفاصيل)
    };

    // مصدر واحد للعلامات — تُبنى منه قوائم الخيارات
    const GRADES = [
        { v: '4.00', l: 'A' }, { v: '3.75', l: '-A' }, { v: '3.50', l: '+B' },
        { v: '3.25', l: '(B)' }, { v: '3.00', l: '(-B)' }, { v: '2.75', l: '(+C)' },
        { v: '2.50', l: '(C)' }, { v: '2.25', l: '(-C)' }, { v: '2.00', l: '(+D)' },
        { v: '1.25', l: '(D)' }, { v: '1.00', l: '(رسوب) (-D)' }
    ];

    // نظاما وزن المحاولة السابقة لمعادات C فما دون — نفس الرموز، قيمتان حسب جيل الطالب:
    // الحالية (2025+)          : C=2.50 · C-=2.25 · D+=2.00 · D=1.25 · D-=1.00
    // قديمة (دفعة 2023/2024)   : C=2.50 · C-=1.75 · D+=1.50 · D=1.00 · D-=0.75
    const OLD_GRADE_SYSTEMS = {
        'new': [['2.50', '(C)'], ['2.25', '(-C)'], ['2.00', '(+D)'], ['1.25', '(D)'], ['1.00', '(رسوب) (-D)']],
        'old': [['2.50', 'C'], ['1.75', 'C-'], ['1.50', 'D+'], ['1.00', 'D'], ['0.75', '(رسوب) -D']]
    };

    // تقديرات المعدل (من الأعلى للأدنى)
    const RATINGS = [
        [3.69, 'امتياز 🥇'], [3.00, 'جيد جداً 🥈'], [2.50, 'جيد 🥉'],
        [2.00, 'مقبول 👍'], [-Infinity, 'ضعيف ⚠️']
    ];

    // وحدات الوقت لمؤشر الحفظ (الأكبر أولاً) — صيغ الجمع العربية: مفرد، مثنى، جمع قلة، جمع كثرة
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
        undoAction: null,          // دالة التراجع الحالية (حذف مادة أو ترحيل فصل)
        gpaHistory: [],            // سجل المعدلات التلقائي: الأقدم ← الأحدث
        undoToastTimeout: null,
        undoInterval: null,
        undoCountReset: null,
        warnTimeout: null,
        lastSaveTime: null,
        timeUpdateInterval: null,
        lastChartDataString: '',
        currentTimestamp: null,
        lastComputed: { gpa: 0, hours: 0, semHours: 0 }, // للترحيل بدل قراءة أرقام أثناء أنيميشنها
        lastFull: null,            // نسخة موسعة لنافذة التفاصيل
        animFrames: new WeakMap()  // يمنع تراكب حركتين على نفس العنصر
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
            'courseTemplate', 'noteTemplates', 'detailTemplates'
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

    // إعادة تشغيل حركة CSS: إزالة الكلاس ثم إضافته بعد reflow
    function retriggerAnimation(el, className) {
        el.classList.remove(className);
        void el.offsetWidth;
        el.classList.add(className);
    }

    // صيغة الجمع العربية: 1، 2، 3-10، 11+
    function pluralize(count, [one, two, few, many]) {
        if (count === 1) return one;
        if (count === 2) return two;
        return (count >= 3 && count <= 10) ? few : many;
    }

    // بناة DOM صغيرة (بديل عن قوالب النصوص HTML داخل JS)
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

    // استنساخ جزء من <template> بحسب محدد
    const fromTemplate = (tpl, selector) => tpl.content.querySelector(selector).cloneNode(true);

    // عدّاد أرقام متحرك: يحرّكه animateValue لاحقاً
    const counter = (target, { prefix = '', float = true, cls = '' } = {}) => {
        const el = h('span', `d-val ${cls}`.trim(), prefix + (float ? '0.00' : '0'));
        el.dataset.target = target;
        el.dataset.prefix = prefix;
        el.dataset.float = float ? '2' : '0';
        return el;
    };

    // حركة عدّاد رقمي — تلغي أي حركة سابقة على نفس العنصر
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

    // تنسيق حقول المعدل تلقائياً: رقم.رقمان، وأقصى قيمة 4.00
    function formatGpaInput(event) {
        if (event.inputType === 'deleteContentBackward') return;
        const input = event.target;
        const value = input.value.replace(/[^0-9]/g, '');
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
            try {
                localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
            } catch (e) {
                console.warn('تعذر حفظ البيانات محلياً:', e);
            }
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
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (!raw) {
                stampNow();
                addDefaultCourses();
                initChart(['المعدل الحالي', 'المعدل الجديد'], [0, 0], 0, 4);
                calculateGPA(false);
                return;
            }

            const saved = JSON.parse(raw);

            if (saved.timestamp) {
                AppState.currentTimestamp = saved.timestamp;
                AppState.lastSaveTime = new Date(saved.timestamp);
            } else {
                stampNow();
            }
            updateSaveIndicator();

            // سجل التطور التلقائي (مع تنقية القيم غير الصالحة)
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
                    oldGrade: c.oldGrade || '1.00'
                })));
            } else {
                addDefaultCourses();
            }
        } catch (error) {
            console.warn('تعذرت قراءة البيانات المحفوظة، سيتم البدء من جديد:', error);
            localStorage.removeItem(CONFIG.STORAGE_KEY);
            addDefaultCourses();
        }
        initChart(['المعدل الحالي', 'المعدل الجديد'], [0, 0], 0, 4);
        calculateGPA(false);
    }

    function resetCalculator() {
        if (!confirm('هل أنت متأكد من رغبتك في تفريغ جميع البيانات وحذف المواد الحالية؟')) return;
        localStorage.removeItem(CONFIG.STORAGE_KEY);
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

        // منع الترحيل المزدوج: النتيجة مطابقة لما هو مسجل أصلاً
        const curGpa = parseFloat(DOM.oldGpa.value) || 0;
        const curHours = parseInt(DOM.oldHours.value, 10) || 0;
        if (Math.abs(computed.gpa - curGpa) < 0.005 && computed.hours === curHours) {
            alert('لا توجد نتائج جديدة للترحيل — أدخل مواد الفصل الحالي أولاً.');
            return;
        }

        if (!confirm('هل تريد ترحيل هذا المعدل ليكون معدلك الحالي، والبدء بفصل جديد؟ \n(سيتم حفظ معدلك الحالي في سجل التطور تلقائياً، ويمكنك التراجع خلال 5 ثوانٍ)')) return;

        const prevGpaVal = DOM.oldGpa.value;
        const prevHist2 = DOM.hist2.value;

        // لقطة كاملة للحالة تتيح التراجع
        const snapshot = {
            oldGpa: prevGpaVal,
            oldHours: DOM.oldHours.value,
            hist1: DOM.hist1.value,
            hist2: prevHist2,
            gpaHistory: [...AppState.gpaHistory],
            hasCelebrated: AppState.hasCelebrated,
            courses: readAllCourses()
        };

        // حفظ المعدل الحالي في سجل التطور التلقائي
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
        AppState.hasCelebrated = computed.gpa >= 3.00; // لا احتفال مباشر بعد الترحيل
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

    // تعبئة قائمة العلامة (العادية أو ناجح/راسب لمادة 0 ساعة) من المصدر الواحد GRADES
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

    // إعادة بناء قائمة "العلامة السابقة" حسب نظام الأوزان المختار،
    // مع الحفاظ على الرمز المختار (C- يبقى C- مهما تبدل النظام)
    function rebuildOldGradeSelect(card) {
        const useOld = card.querySelector('.old-weight-pill').classList.contains('active');
        const select = card.querySelector('.old-grade');
        const currentVal = select.value;

        // رمز الاختيار الحالي من أي نظام كان
        let symbol = null;
        for (const set of Object.values(OLD_GRADE_SYSTEMS)) {
            const hit = set.find(([v]) => v === currentVal);
            if (hit) { symbol = hit[1]; break; }
        }

        const opts = OLD_GRADE_SYSTEMS[useOld ? 'old' : 'new'];
        select.replaceChildren(...opts.map(([v, l]) => new Option(l, v)));

        const match = symbol ? opts.find(([, l]) => l === symbol) : null;
        select.value = match ? match[0] : opts[opts.length - 1][0]; // الافتراضي: أدنى رمز (D-)
    }

    // ضبط قيمة قائمة، مع الرجوع لقيمة افتراضية إن لم تكن ضمن الخيارات
    function setSelectValue(select, value, fallback) {
        select.value = value;
        if (select.selectedIndex < 0) select.value = fallback;
    }

    function toggleRepeat(checkbox) {
        checkbox.closest('.course-options').querySelector('.old-grade-wrapper').classList.toggle('show', checkbox.checked);
        checkbox.closest('.course-card').classList.toggle('repeated', checkbox.checked);
    }

    // قراءة حالة بطاقة مادة (مصدر واحد للحفظ والحساب واللقطات)
    function readCourse(card) {
        const hours = card.querySelector('.course-hours').value;
        return {
            hours,
            grade: card.querySelector('.course-grade').value,
            // مادة الصفر ساعة لا يوجد لها خيار "مادة معادة"
            isRepeated: hours !== '0' && card.querySelector('.repeat-checkbox').checked,
            oldGrade: card.querySelector('.old-grade').value,
            // نظام وزن المحاولة السابقة: قديم (2023/2024) أو حالي
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
        // نظام الأوزان: من الحقول المحفوظة، أو استنتاجه من قيمة قديمة (1.75/1.50/0.75 = نظام قديم)
        const savedOld = course && course.oldGrade;
        const useOld = (course && course.oldSystem === 'old')
            || (!!savedOld && ['1.75', '1.50', '0.75'].includes(savedOld));
        const pill = card.querySelector('.old-weight-pill');
        pill.classList.toggle('active', useOld);
        pill.setAttribute('aria-pressed', String(useOld));
        rebuildOldGradeSelect(card); // يبني خيارات النظام المختار أولاً
        setSelectValue(card.querySelector('.old-grade'), savedOld || (useOld ? '0.75' : '1.00'), useOld ? '0.75' : '1.00');

        card.querySelector('.repeat-checkbox').checked = repeated;
        card.querySelector('.checkbox-label').hidden = isZero;
        card.querySelector('.old-grade-wrapper').classList.toggle('show', repeated);
        card.classList.toggle('repeated', repeated);
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
        const cards = Array.from(DOM.coursesContainer.querySelectorAll('.course-card'));

        if (cards.length <= 1) {
            alert('يجب إبقاء مادة واحدة على الأقل في الجدول.');
            return;
        }

        const deleted = { ...readCourse(card), index: cards.indexOf(card) };
        card.classList.add('removing');

        setTimeout(() => {
            card.remove();
            updateCourseNumbers();
            debouncedCalculateAndSave();
            // التراجع يُعيد المادة إلى مكانها الأصلي
            showUndoToast('تم حذف المادة', () => {
                const restored = createCourseElement(deleted);
                const ref = DOM.coursesContainer.children[deleted.index];
                DOM.coursesContainer.insertBefore(restored, ref || null);
                updateCourseNumbers();
                calculateGPA(true);
            });
        }, 250);
    }

    // تغيير عدد الساعات: إعادة بناء قائمة العلامات وإخفاء "معادة" عند 0 ساعة
    function onHoursChange(select) {
        const card = select.closest('.course-card');
        const gradeSelect = card.querySelector('.course-grade');
        const repeatLabel = card.querySelector('.checkbox-label');
        const repeatBox = card.querySelector('.repeat-checkbox');
        const isZero = select.value === '0';

        fillGradeSelect(gradeSelect, isZero);
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

        // إعادة تشغيل العدّاد الدائري (تنسيقه في CSS)
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
        // نُبقي العدّاد حتى ينتهي انزلاق الإشعار للخارج
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
        void toast.offsetWidth; // إعادة تشغيل حركة الدخول وشريط العدّاد
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
    // 7. الحساب النقي (لا يمس DOM)
    // ==========================================
    // courses: [{hours, grade, isRepeated, oldGrade}]
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
            } else if (grade === 'fail') {
                // راسب بلا علامة رقمية: لا ساعات ولا نقاط
            } else if (grade !== '') {
                const gradeValue = parseFloat(grade) || 0;
                const oldGradeValue = parseFloat(c.oldGrade) || 0;
                if (!c.isRepeated) {
                    finalTotalHours += hours;
                    gpaHours += hours;
                } else if (oldHours === 0) {
                    // لا سجل سابق يُستبدل (طالب مستجد) ⇒ تُعامل كمادة جديدة بالكامل
                    finalTotalHours += hours;
                    gpaHours += hours;
                }
                // المعادة بأي علامة سابقة: لا تُضاف ساعات إطلاقاً — ساعاتها محتسبة
                // في الساعات المقطوعة أصلاً، وإلا تُزداد عند تكرار مادتين أو أكثر
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
            finalTotalPoints,
            finalTotalHours,
            gpaHours,
            newSemesterHours,
            registeredSemesterHours
        };
    }

    // اختبارات ذاتية للمنطق النقي — من كونسول المتصفح: runSelfTests()
    function runSelfTests() {
        let pass = 0, total = 0;
        const check = (actual, expected, name) => {
            total++;
            const ok = Math.abs(actual - expected) < 0.005;
            if (ok) pass++;
            console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — الناتج ${actual} والمتوقع ${expected}`}`);
        };
        const C = (hours, grade, isRepeated = false, oldGrade = '1.00') => ({ hours, grade, isRepeated, oldGrade });

        let r = computeGPA(2.86, 76, []);
        check(r.finalGpa, 2.86, 'ثبات المعدل بدون مواد');
        check(r.finalTotalHours, 76, 'الساعات بدون مواد');

        r = computeGPA(2.86, 76, [C(3, '4.00')]);
        check(r.finalGpa, (2.86 * 76 + 12) / 79, 'إضافة A بـ 3 ساعات');
        check(r.gpaHours, 79, 'ساعات المعدل بعد الإضافة');

        r = computeGPA(2.00, 60, [C(3, '3.00', true, '1.00')]);
        check(r.finalTotalHours, 60, 'المعادة بالرسوب لا تضيف ساعات مقطوعة');
        check(r.gpaHours, 60, 'ساعات المعدل ثابتة للمعادة بالرسوب');

        // انحدار سابق: مادتان معادتان بالرسوب كانت تزيدان الساعات — يجب ألا يحدث الآن
        r = computeGPA(2.00, 60, [C(3, '3.00', true, '1.00'), C(3, '4.00', true, '1.00')]);
        check(r.finalTotalHours, 60, 'مادتان معادتان: الساعات لا تزيد أبداً');
        check(r.finalGpa, (120 - 6 + 21) / 60, 'نقاط المادتين المعادتين تُستبدلان صح');

        r = computeGPA(2.00, 60, [C(3, '3.00', true, '1.25')]);
        check(r.finalTotalHours, 60, 'المعادة بـ D لا تضيف ساعات مقطوعة');

        r = computeGPA(0, 0, [C(3, '3.50', true, '1.00')]);
        check(r.finalGpa, 3.50, 'مستجد + معادة: لا نقاط سالبة');
        check(r.finalTotalPoints >= 0 ? 1 : 0, 1, 'النقاط التراكمية غير سالبة');

        r = computeGPA(2.50, 30, [C(3, 'pass')]);
        check(r.finalTotalHours, 33, '"ناجح" يضيف للمقطوعة');
        check(r.gpaHours, 30, '"ناجح" لا يدخل المعدل');

        r = computeGPA(2.50, 30, [C(3, 'fail')]);
        check(r.finalTotalHours, 30, '"راسب" لا يضيف ساعات');

        r = computeGPA(2.50, 30, [C(3, ''), C(3, '4.00')]);
        check(r.registeredSemesterHours, 3, 'ساعات الفصل للمقيّمة فقط');

        console.log(`\nالنتيجة النهائية: ${pass}/${total} اختباراً ناجحاً`);
        return pass === total;
    }

    // درع أمان: أي خطأ في الحساب يُسجَّل ولا يجمّد الواجهة
    function calculateGPA(isUserAction = false) {
        try {
            calculateGPACore(isUserAction);
        } catch (err) {
            console.error('خطأ أثناء الحساب (أُبقي على آخر نتيجة صالحة):', err);
        }
    }

    // isUserAction: true إذا كان التعديل فعلاً مباشراً من الطالب (لتحديث وقت الحفظ)
    function calculateGPACore(isUserAction) {
        if (isUserAction) stampNow();

        // لا نُقصّ الساعات المقطوعة على خطة التخصص — ذلك يُفسد نقاط المعدل الحقيقية.
        // التضارب يُعالج كتحذير فقط في updateProgressSection.
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
        const { semesterGpa, finalGpa, finalTotalHours, gpaHours, newSemesterHours, registeredSemesterHours } = result;

        AppState.lastComputed = { gpa: finalGpa, hours: finalTotalHours, semHours: newSemesterHours };
        AppState.lastFull = { oldGpa, oldHours, finalGpa, gpaHours, finalTotalHours, semesterGpa, newSemHours: newSemesterHours, courses: coursesInput };

        renderResults(result);
        updateProgressSection(finalTotalHours, gpaHours, finalGpa);
        checkAcademicWarnings(finalTotalHours, finalGpa, isUserAction);
        updateChart(oldGpa, finalGpa);
    }

    // ==========================================
    // 8. عرض النتائج والتقدم والتحذيرات
    // ==========================================
    const readNumber = (el) => parseFloat(el.textContent.replace(/[^0-9.]/g, '')) || 0;

    function renderResults({ finalGpa, semesterGpa, finalTotalHours, registeredSemesterHours }) {
        animateValue(DOM.resultGpa, readNumber(DOM.resultGpa), finalGpa, 250, true);
        animateValue(DOM.semesterGpaBadge, readNumber(DOM.semesterGpaBadge), semesterGpa, 250, true, '<svg class="icon"><use href="#icon-pie"/></svg> المعدل الفصلي: ');
        animateValue(DOM.resultHours, readNumber(DOM.resultHours), finalTotalHours, 250, false, '<svg class="icon"><use href="#icon-clock"/></svg> مجموع الساعات: ');
        animateValue(DOM.semesterHoursBadge, readNumber(DOM.semesterHoursBadge), registeredSemesterHours, 250, false, 'ساعات الفصل: ');
    }

    /**
     * ملاحظة الخطة: القوالب في #noteTemplates (index.html).
     * - تغيّر القالب  ⇒ استنساخ + تلاشٍ كامل، وتُضبط الأرقام فوراً.
     * - ثبات القالب وتغيّر الأرقام فقط ⇒ عدّاد متحرك على الأرقام بلا تلاشٍ.
     */
    const NoteAnim = { key: 'idle' }; // 'idle' مطابق لنص HTML الأولي

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

        // ساعات منجزة أكبر من الخطة (غالباً رقم الخطة خطأ): نُنبّه ولا نقصّ أي رقم
        const inconsistent = planTotal > 0 && finalTotalHours > planTotal;
        DOM.planTotal.classList.toggle('is-invalid', inconsistent);

        if (inconsistent) {
            setProgress(100);
            setNote('plan-warning', [finalTotalHours, planTotal]);
            return;
        }

        if (!(planTotal > 0 && finalTotalHours > 0)) {
            DOM.progressFill.style.setProperty('--progress', '0%');
            DOM.progressPercent.textContent = '0%';
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

        // النقاط المكتسبة = ساعات المعدل × المعدل (مواد "ناجح" تُضاف للساعات بلا نقاط)
        const requiredGpa = (planTotal * planTarget - gpaHours * finalGpa) / remaining;

        if (requiredGpa > CONFIG.GRADE_MAX) setNote('impossible');
        else if (requiredGpa <= 0) setNote('secured');
        else setNote('need', [requiredGpa, remaining], [true, false]);
    }

    // isUserAction: الاهتزاز والاحتفال فقط مع تفاعل المستخدم
    function checkAcademicWarnings(finalTotalHours, finalGpa, isUserAction) {
        let ratingText = '-';

        if (finalTotalHours > 0) {
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
                hideWarnBanner();
            }

            if (finalGpa >= 3.00 && !AppState.hasCelebrated && isUserAction) {
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
    // 9. نافذة تفاصيل استقرار المعدل
    // ==========================================
    /*
     * سقف تحسّن المعدل:  ΔGPA_max = (4 − Gc) × (Ht − Hc) / Ht
     *   Gc: المعدل الحالي · Hc: الساعات المحتسبة · Ht: إجمالي ساعات التخصص
     * يُعد المعدل "شبه مثبت" عندما يصبح السقف ≤ STABLE_DELTA.
     */
    function buildDetailsContent() {
        const body = DOM.detailsBody;
        const f = AppState.lastFull || {};
        const H = f.gpaHours || 0;
        const G = f.finalGpa || 0;
        const planTotal = parseFloat(DOM.planTotal.value) || 0;
        const tpl = (name) => fromTemplate(DOM.detailTemplates, `[data-tpl="${name}"]`);

        if (!H) {
            body.replaceChildren(tpl('empty-no-data'));
            return;
        }

        // عنصر تفصيل بترتيب ظهور متدرج (--i يقرأه CSS)
        let order = 0;
        const item = (iconId, label, ...kids) => {
            const el = h('div', 'detail-item', h('div', 'detail-label', icon(iconId), ` ${label}`), ...kids);
            el.style.setProperty('--i', ++order);
            return el;
        };
        const row = (cls, ...kids) => h('div', `effect-row ${cls}`.trim(), ...kids);
        const span = (cls, ...kids) => h('span', cls, ...kids);

        // أثر مادة 3 ساعات بعلامة محددة: Δ = 3(g − G) / (H + 3)
        const eff = (g) => (3 * (g - G)) / (H + 3);
        const parts = [];

        if (planTotal > 0 && planTotal >= H) {
            const remainPlan = planTotal - H;
            const completion = Math.round((H / planTotal) * 100);
            const dMax = ((4 - G) * remainPlan) / planTotal;  // سقف الصعود
            const dMin = ((G - 1) * remainPlan) / planTotal;  // سقف الهبوط (أدنى متوسط للمتبقي = 1.00)
            const stable = dMax <= CONFIG.STABLE_DELTA;

            // (1) بطل السقف
            const chipText = stable ? '✅ مستقر' : dMax <= 0.30 ? '⏳ استقرار جزئي' : '⚡ لم يستقر بعد';
            const caption = stable
                ? `حتى لو أتممت المتبقي كله بعلامات كاملة، لن يرتفع معدلك أكثر من +${dMax.toFixed(2)} — معدلك شبه مثبت`
                : `لو أنجزت كل ساعاتك المتبقية (${remainPlan} سا) بعلامة كاملة (A)، فهذا أقصى ما سيصعد إليه معدلك`;
            const bar = h('div', 'stab-hero-bar', h('span'));
            bar.style.setProperty('--pct', `${completion}%`);

            parts.push(item('icon-award', 'سقف تحسّن معدلك (ΔGPA الأقصى)',
                h('div', 'stab-hero',
                    h('div', 'stab-hero-top',
                        h('div', 'stab-hero-num', counter(dMax, { prefix: '+' }), ' ', h('small', '', `أنجزت ${H} من ${planTotal} سا (${completion}%)`)),
                        h('span', `stab-hero-state ${stable ? 'ok' : 'wait'}`, chipText)),
                    bar,
                    h('div', 'stab-hero-cap', caption))));

            // (2) نقطة التعادل: فصلي ≥ التراكمي يرفعه، وأقل ينزله — الهدف الدنيا لكل فصل
            {
                const breakEvenRows = [
                    row('', span('', 'معدل فصلي'), counter(G, { cls: 'tone-primary' }), span('', 'أو أكثر يرفع تراكمك ▲'))
                ];
                if (f.newSemHours > 0 && f.semesterGpa > 0) {
                    const above = f.semesterGpa >= G;
                    breakEvenRows.push(row(above ? 'effect-row--ok' : 'effect-row--strong',
                        span('', 'فصلك الحالي'),
                        span(above ? 'is-up' : 'is-down', f.semesterGpa.toFixed(2)),
                        span(above ? 'tone-primary' : 'tone-strong', above ? 'فوق التعادل ✓' : 'تحت التعادل — ارفعه ⚠')));
                }
                parts.push(item('icon-clock', 'نقطة التعادل', ...breakEvenRows));
            }

            // (3) النقاط نحو الهدف: المحققة فعلاً ÷ المطلوبة (مؤشر تقدم ملموس)
            if (planTarget > 0) {
                const earnedPts = G * H;                  // نقاطك الحقيقية المحتسبة
                const neededPts = planTarget * planTotal; // نقاط الهدف
                const ptsPct = Math.min(100, Math.round((earnedPts / neededPts) * 100));
                const securedPts = earnedPts >= neededPts;
                const ptsBar = h('div', 'stab-hero-bar', h('span'));
                ptsBar.style.setProperty('--pct', `${ptsPct}%`);

                parts.push(item('icon-cap', 'النقاط نحو هدفك',
                    h('div', 'stab-hero',
                        h('div', 'stab-hero-top',
                            h('div', 'stab-hero-num', counter(Math.round(earnedPts), { float: false }), ' ', h('small', '', `/ ${Math.round(neededPts)} مطلوبة (${ptsPct}%)`)),
                            h('span', `stab-hero-state ${securedPts ? 'ok' : 'wait'}`, securedPts ? '✅ ضمنته' : `${ptsPct}%`)),
                        ptsBar,
                        h('div', 'stab-hero-cap', securedPts
                            ? 'نقاطك الحالية تكفي للمعدل المستهدف — حافظ على المستوى'
                            : `حققت ${ptsPct}% من نقاط هدفك — تبقى ${Math.round(neededPts - earnedPts)} نقطة`))));
            }

            // (4) متى يستقر؟  Hc ≥ Ht × (1 − δ/(4−G))
            if (stable) {
                parts.push(item('icon-clock', 'متى يستقر معدلي؟',
                    row('effect-row--ok', span('', '✅ معدلك مستقر الآن فعلاً'), span('tone-primary', `سقف تحسنه ≤ ${CONFIG.STABLE_DELTA.toFixed(2)}`))));
            } else {
                const stableAt = Math.ceil(planTotal * (1 - CONFIG.STABLE_DELTA / (4 - G)));
                const remainStable = Math.max(0, stableAt - H);
                const semesters = Math.ceil(remainStable / CONFIG.SEMESTER_HOURS);
                const semText = semesters > 0 ? ` (~${semesters} ${semesters === 1 ? 'فصل' : 'فصول'})` : '';
                parts.push(item('icon-clock', 'متى يستقر معدلي؟',
                    row('', span('', 'يستقر عند'), span('', counter(stableAt, { float: false }), ' ساعة محتسبة')),
                    row('', span('', 'أي بعد'), span('', counter(remainStable, { float: false }), ` ساعة إضافية${semText}`))));
            }

            // (5) سقفا الصعود والهبوط
            parts.push(item('icon-pie', 'سقفا التغيّر المتبقيين',
                row('', span('', 'أقصى صعود (A بكل المتبقي)'), counter(dMax, { prefix: '+', cls: 'is-up' })),
                row('', span('', 'أقصى هبوط (رسوب بكل المتبقي)'), counter(dMin, { prefix: '−', cls: 'is-down' }))));
        } else {
            // بلا خطة معلومة: المعادلة تحتاج Ht
            parts.push(item('icon-cap', 'تحليل الاستقرار', tpl('empty-no-plan')));
        }

        // (4) أثر الفصل الحالي على التراكمي
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

        // (6) قراءة التاريخ المسجل: الاتجاه + توقع التخرج + التذبذب
        // يستفيد من gpaHistory التي يملؤها الترحيل التلقائي أو نافذة "إضافة جميع الفصول"
        const hist = (AppState.gpaHistory || []).filter(v => !isNaN(v));
        if (hist.length >= 2) {
            const n = hist.length;
            const firstV = hist[0], lastV = hist[n - 1];
            const rate = (lastV - firstV) / (n - 1); // متوسط التغير/فصل
            const maxV = Math.max(...hist), minV = Math.min(...hist);
            const labelFor = (i) => {
                const d = n - i;
                return d === 1 ? 'الفصل الماضي' : d === 2 ? 'منذ فصلين' : `منذ ${d} فصول`;
            };
            const swing = maxV - minV;
            const [tone, toneLabel] = swing <= 0.15 ? ['ok', 'أداء مستقر']
                : swing <= 0.35 ? ['medium', 'تذبذب متوسط']
                : ['strong', 'أداء متقلب'];

            const rows = [
                row('', span('', 'متوسط تغيّرك/فصل'),
                    counter(rate, { prefix: rate >= 0 ? '+' : '', cls: rate >= 0 ? 'is-up' : 'is-down' }))
            ];

            // توقع التخرج عند استمرار الوتيرة (يتطلب معرفة الخطة)
            if (planTotal > 0 && planTotal > H && Math.abs(rate) >= 0.005) {
                const semsLeft = Math.ceil((planTotal - H) / CONFIG.SEMESTER_HOURS);
                if (semsLeft > 0) {
                    const projected = Math.min(CONFIG.GRADE_MAX, Math.max(0, lastV + rate * semsLeft));
                    rows.push(row('',
                        span('', `عند هذا الوتيرة (${semsLeft} ${pluralize(semsLeft, ['فصل', 'فصلين', 'فصول', 'فصل'])} للتخرج)`),
                        counter(projected, { cls: projected >= lastV ? 'is-up' : 'is-down' })));
                }
            }

            rows.push(
                row('', span('', `أعلى معدل (${labelFor(hist.indexOf(maxV))})`), span('', maxV.toFixed(2))),
                row('', span('', `أدنى معدل (${labelFor(hist.indexOf(minV))})`), span('', minV.toFixed(2))),
                row(`effect-row--${tone}`, span('', 'مدى التذبذب'), span(`tone-${tone}`, `${swing.toFixed(2)} · ${toneLabel}`))
            );

            parts.push(item('icon-cap', `قراءة تاريخك (${n} ${pluralize(n, ['فصل', 'فصلين', 'فصول', 'فصل'])})`, ...rows));
        }

        // (7) أثر مادة واحدة (3 ساعات)
        // (7) أثر مادة واحدة (3 ساعات)
        parts.push(item('icon-book', 'لو أضفت مادة 3 ساعات الآن',
            row('', span('grade-tag grade-tag--best', 'A كاملة'), span('', 'ستغيّر تراكميك'), counter(eff(4), { prefix: '+', cls: 'is-up' })),
            row('', span('grade-tag grade-tag--worst', 'رسوب (-D)'), span('', 'ستغيّر تراكميك'), counter(eff(1), { cls: 'is-down' }))));

        // (9) القاعدة الختامية
        const rule = tpl('rule');
        rule.querySelector('.rule-delta').textContent = CONFIG.STABLE_DELTA.toFixed(2);
        rule.classList.add('detail-item');
        rule.style.setProperty('--i', ++order);
        parts.push(rule);

        body.replaceChildren(...parts);
    }

    // تحريك أرقام النافذة بعدّاد عند فتحها
    function animateDetailVals() {
        DOM.detailsBody.querySelectorAll('.d-val').forEach(el => {
            animateValue(el, 0, parseFloat(el.dataset.target) || 0, 700, el.dataset.float !== '0', el.dataset.prefix || '');
        });
    }

    // الحركات كلها في CSS (كلاسا open / closing) — JS ينتظر انتهاءها فقط
    function openDetailsModal() {
        const modal = DOM.detailsModal;
        buildDetailsContent();
        modal.classList.remove('closing');
        modal.hidden = false;
        void modal.offsetWidth;
        modal.classList.add('open');
        modal.querySelector('.bau-modal-card').addEventListener('animationend', animateDetailVals, { once: true });
    }

    function closeDetailsModal() {
        const modal = DOM.detailsModal;
        if (modal.hidden || modal.classList.contains('closing')) return;
        modal.classList.remove('open');
        modal.classList.add('closing');
        modal.querySelector('.bau-modal-card').addEventListener('animationend', () => {
            modal.hidden = true;
            modal.classList.remove('closing');
        }, { once: true });
    }

    // ==========================================
    // 9ب. نافذة "إضافة جميع الفصول" — إدارة سجل التتبع بصفوف ديناميكية
    // ==========================================
    // صف معدل: ترقيم + حقل منسق (data-gpa) + زر حذف — بنفس فلسفة بطاقات المواد
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
            rows[0].querySelector('input').value = ''; // صف واحد يبقى لكن يُفرَّغ
            return;
        }
        button.closest('.hist-row').remove();
        updateHistoryNumbers();
    }

    function openHistoryModal() {
        // ابنِ الصفوف من السجل الحالي (الأقدم ← الأحدث)؛ صف فارغ واحد إن كان فارغاً
        const values = (AppState.gpaHistory || []).map(v => Number(v).toFixed(2));
        DOM.historyList.replaceChildren(...(values.length ? values : ['']).map(createHistoryRow));
        updateHistoryNumbers();

        const modal = DOM.historyModal;
        modal.classList.remove('closing');
        modal.hidden = false;
        void modal.offsetWidth;
        modal.classList.add('open');
    }

    function closeHistoryModal() {
        const modal = DOM.historyModal;
        if (modal.hidden || modal.classList.contains('closing')) return;
        modal.classList.remove('open');
        modal.classList.add('closing');
        modal.querySelector('.bau-modal-card').addEventListener('animationend', () => {
            modal.hidden = true;
            modal.classList.remove('closing');
        }, { once: true });
    }

    // الحفظ: تجمع القيم (الأقدم ← الأحدث) وتكتبها للسجل وخانتي hist1/hist2 ثم تعيد الحساب
    function saveHistoryModal() {
        const values = Array.from(DOM.historyList.querySelectorAll('.hist-input'))
            .map(i => parseFloat(i.value))
            .filter(v => !isNaN(v) && v >= 0 && v <= CONFIG.GRADE_MAX);

        AppState.gpaHistory = values.slice(-CONFIG.MAX_TRACKED);

        // الخانتان اليدويتان المرئيتان = آخر معدلين (توافق رجعي مع الرسم الحالي)
        const n = values.length;
        DOM.hist1.value = n >= 2 ? values[n - 2].toFixed(2) : '';
        DOM.hist2.value = n >= 1 ? values[n - 1].toFixed(2) : '';

        closeHistoryModal();
        calculateGPA(true); // يحفظ gpaHistory محدثاً ويعيد رسم المنحنى
    }

    // ==========================================
    // 10. الرسم البياني والاحتفال
    // ==========================================
function updateChart(oldGpa, finalGpa) {
    try {
        // 1. جلب العناصر بأمان تام (Fallback to null)
        const hist1Element = document.getElementById('hist1');
        const hist2Element = document.getElementById('hist2');
        
        const h1 = hist1Element ? parseFloat(hist1Element.value) : NaN;
        const h2 = hist2Element ? parseFloat(hist2Element.value) : NaN;

        // 2. السجل من حالة التطبيق — يملؤه الترحيل التلقائي ونافذة "إضافة جميع الفصول"
        let historyArray = Array.isArray(AppState.gpaHistory) ? [...AppState.gpaHistory] : [];
        let mergedHistory = [...historyArray];

        // مزامنة الإدخال اليدوي بأمان
        if (!isNaN(h2)) {
            if (mergedHistory.length >= 1) mergedHistory[mergedHistory.length - 1] = h2;
            else mergedHistory.push(h2);
        }
        if (!isNaN(h1)) {
            if (mergedHistory.length >= 2) mergedHistory[mergedHistory.length - 2] = h1;
            else if (mergedHistory.length === 1) mergedHistory.unshift(h1);
            else if (mergedHistory.length === 0) { mergedHistory.push(h1); if (!isNaN(h2)) mergedHistory.push(h2); }
        }

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

        // 3. منع إعادة الرسم غير المبرر للحفاظ على الأداء
        const signature = JSON.stringify({ labels, data });
        if (window.lastChartDataString === signature) return;
        window.lastChartDataString = signature;

        // 4. استدعاء دالة الرسم بأمان (تأكد أن اسم دالة الرسم الخاصة بك هو initChart)
        if (typeof initChart === 'function') {
            const yMin = Math.max(0, Math.min(...data) - 0.15);
            const yMax = Math.min(4.0, Math.max(...data) + 0.15); // 4.0 هو سقف معدلات البلقاء
            initChart(labels, data, yMin, yMax);
        }

    } catch (error) {
        // إذا حدث خطأ هنا، سيتم طباعته في الكونسول ولن ينهار باقي الموقع
        console.error("تم احتواء خطأ في رسم المنحنى:", error);
    }
}

    function initChart(labels, data, yMin, yMax) {
        const canvas = document.getElementById('gpaChart');
        if (!canvas || typeof Chart === 'undefined') return; // Chart.js لم يُحمّل (أو فشل تحميله)

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

    // احتفال حسب المستوى: gold (امتياز) / silver (جيد جداً)
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
        // ---- المواد (تفويض أحداث) ----
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
            if (t.classList.contains('repeat-checkbox')) {
                toggleRepeat(t);
                debouncedCalculateAndSave();
            } else if (t.classList.contains('course-hours')) {
                onHoursChange(t);
                debouncedCalculateAndSave();
            }
        });

        // ---- أي إدخال: تنسيق/تقييد الحقول المعلَّمة ثم إعادة الحساب ----
        DOM.appContainer.addEventListener('input', (e) => {
            const t = e.target;
            if (t.matches('[data-gpa]')) formatGpaInput(e);
            else if (t.matches('[data-max]') && Number(t.value) > Number(t.dataset.max)) t.value = t.dataset.max;
            debouncedCalculateAndSave();
        });

        // ---- الأزرار ----
        const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);
        on('resetBtn', resetCalculator);
        on('addCourseBtn', addCourse);
        on('nextSemesterBtn', moveToNextSemester);
        on('undoBtn', undoDelete);
        on('detailsBtn', openDetailsModal);
        on('detailsCloseBtn', closeDetailsModal);
        on('detailsBackdrop', closeDetailsModal);

        // ---- نافذة فصول التتبع ----
        on('historyBtn', openHistoryModal);
        on('historyCloseBtn', closeHistoryModal);
        on('historyBackdrop', closeHistoryModal);
        on('historyAddBtn', () => addHistoryRow());
        on('historySaveBtn', saveHistoryModal);

        DOM.historyModal.addEventListener('click', (e) => {
            const del = e.target.closest('.hist-del');
            if (del) removeHistoryRow(del);
        });
        // تنسيق حقول المعدلات داخل النافذة (خارج appContainer)
        DOM.historyModal.addEventListener('input', (e) => {
            if (e.target.matches('[data-gpa]')) formatGpaInput(e);
        });
        DOM.historyModal.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('input')) saveHistoryModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeDetailsModal(); closeHistoryModal(); }
        });
    }

    window.addEventListener('DOMContentLoaded', () => {
        cacheDOM();

        // مدد العدّادات تُقرأ في CSS من متغيراتها — قيمة واحدة في JS
        const root = document.documentElement.style;
        root.setProperty('--undo-duration', `${CONFIG.UNDO_MS}ms`);
        root.setProperty('--warn-duration', `${CONFIG.WARN_MS}ms`);

        bindEvents();
        loadData();

        clearInterval(AppState.timeUpdateInterval);
        AppState.timeUpdateInterval = setInterval(updateSaveIndicator, CONFIG.SAVE_REFRESH_MS);
    });

    // متاحة من كونسول المتصفح للتحقق من قواعد الحساب
    window.runSelfTests = runSelfTests;
})();
