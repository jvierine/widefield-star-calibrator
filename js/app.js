(function () {
    "use strict";

    const APP_VERSION = "v0.2.6";
    const LOCAL_TEST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
    const LOCAL_TEST_CASES_ENABLED = location.protocol === "file:" || LOCAL_TEST_HOSTS.has(location.hostname);
    const NOT_STAR_TILE_SIZE = 128;
    const canvas = document.getElementById("glCanvas");
    const rotationCanvas = document.getElementById("rotationCanvas");
    const rotationContext = rotationCanvas.getContext("2d");
    const zoomCanvas = document.getElementById("zoomCanvas");
    const zoomContext = zoomCanvas.getContext("2d", {willReadFrequently: true});
    const hint = document.getElementById("canvasHint");
    const cardinalLayer = document.getElementById("cardinalLayer");
    const statusEl = document.getElementById("status");
    const appVersionEl = document.getElementById("appVersion");
    const matchInstructions = document.getElementById("matchInstructions");
    const residualHistogram = document.getElementById("residualHistogram");
    const triangleDebugPlot = document.getElementById("triangleDebugPlot");
    const lensEquation = document.getElementById("lensEquation");
    const densityPopup = document.getElementById("densityPopup");
    const densityPopupSubtitle = document.getElementById("densityPopupSubtitle");
    const densityPopupClose = document.getElementById("densityPopupClose");
    const densityCanvas = document.getElementById("densityCanvas");
    const densityContext = densityCanvas.getContext("2d");
    const loadingOverlay = document.getElementById("loadingOverlay");
    const loadingBar = document.getElementById("loadingBar");
    const loadingText = document.getElementById("loadingText");
    if (appVersionEl) {
        appVersionEl.textContent = APP_VERSION;
    }
    const defaultImage = {
        url: "calibration_images/2025_02_19_03_47_01_000_010881_ams0882_first1s.png",
        name: "2025_02_19_03_47_01_000_010881_ams0882_first1s.png",
    };
    const BROWN_CONRADY_OPTMOD = 20;
    const controls = {
        file: document.getElementById("imageFile"),
        timestampUtc: document.getElementById("timestampUtc"),
        latDeg: document.getElementById("latDeg"),
        lonDeg: document.getElementById("lonDeg"),
        altM: document.getElementById("altM"),
        brightness: document.getElementById("brightness"),
        brightnessValue: document.getElementById("brightnessValue"),
        contrast: document.getElementById("contrast"),
        contrastValue: document.getElementById("contrastValue"),
        highPassImage: document.getElementById("highPassImage"),
        highPassWidth: document.getElementById("highPassWidth"),
        highPassWidthValue: document.getElementById("highPassWidthValue"),
        maxMag: document.getElementById("maxMag"),
        magValue: document.getElementById("magValue"),
        flipX: document.getElementById("flipX"),
        flipY: document.getElementById("flipY"),
        flipImageX: document.getElementById("flipImageX"),
        flipImageY: document.getElementById("flipImageY"),
        toggleRaDecGrid: document.getElementById("toggleRaDecGrid"),
        toggleAzElGrid: document.getElementById("toggleAzElGrid"),
        toggleDetectionCircles: document.getElementById("toggleDetectionCircles"),
        toggleStarNames: document.getElementById("toggleStarNames"),
        toggleAmbientMusic: document.getElementById("toggleAmbientMusic"),
        resetOffset: document.getElementById("resetOffset"),
        optmod: document.getElementById("optmod"),
        fScaleX: document.getElementById("fScaleX"),
        fScaleY: document.getElementById("fScaleY"),
        rotAlpha: document.getElementById("rotAlpha"),
        rotBeta: document.getElementById("rotBeta"),
        rotGamma: document.getElementById("rotGamma"),
        du: document.getElementById("du"),
        dv: document.getElementById("dv"),
        radialAlpha: document.getElementById("radialAlpha"),
        brownConradyParams: document.getElementById("brownConradyParams"),
        brownK2: document.getElementById("brownK2"),
        brownK3: document.getElementById("brownK3"),
        brownP1: document.getElementById("brownP1"),
        brownP2: document.getElementById("brownP2"),
        luckyFit: document.getElementById("luckyFit"),
        fitLens: document.getElementById("fitLens"),
        fitLensLm: document.getElementById("fitLensLm"),
        undoFit: document.getElementById("undoFit"),
        exportLanguage: document.getElementById("exportLanguage"),
        copyOptpar: document.getElementById("copyOptpar"),
        copyPythonMapper: document.getElementById("copyPythonMapper"),
        localTestCaseTools: document.getElementById("localTestCaseTools"),
        submitTestCase: document.getElementById("submitTestCase"),
        saveFeedback: document.getElementById("saveFeedback"),
        testCaseSelect: document.getElementById("testCaseSelect"),
        loadTestCase: document.getElementById("loadTestCase"),
        toggleFitResiduals: document.getElementById("toggleFitResiduals"),
        clearMatches: document.getElementById("clearMatches"),
    };

    const gl = canvas.getContext("webgl", {antialias: true, preserveDrawingBuffer: true});
    if (!gl) {
        statusEl.textContent = "WebGL is not available in this browser.";
        return;
    }

    const state = {
        image: null,
        texture: null,
        imagePixels: null,
        displayPixels: null,
        highPassCacheKey: "",
        imageName: "",
        localImageUrl: null,
        baseOptpar: null,
        modelOptpar: null,
        loadedTestCaseId: "",
        imageLoadId: 0,
        flipX: false,
        flipY: false,
        imageFlipX: false,
        imageFlipY: false,
        displayMode: "pairing",
        previousAnnotatedDisplayMode: "pairing",
        ambientMusic: null,
        maxMagByMode: {stellarium: 6.0, pairing: 4.0, pureImage: 6.0, pureStellarium: 6.0},
        starNamesByMode: {stellarium: false, pairing: true},
        showRaDecGrid: false,
        showAzElGrid: true,
        showStarNames: true,
        dragging: false,
        lensDragMode: "none",
        lastMouse: [0, 0],
        projected: [],
        starMatchMode: false,
        deleteDetectionMode: false,
        maskMode: false,
        zoomMode: false,
        maskRegions: [],
        junkStarFinderRegions: [],
        badStarFinderDetections: [],
        notStarTiles: [],
        notStarTileKeys: new Set(),
        notStarTilePreview: null,
        notStarTilePaintActive: false,
        lastNotStarTilePaintPoint: null,
        junkStarFinderPreview: null,
        junkStarFinderPaintActive: false,
        lastJunkStarFinderPoint: null,
        detectedStars: [],
        currentImageMetadata: null,
        showAutoDetectionMarkers: true,
        deletedDetectionIds: new Set(),
        autoMatches: [],
        detectorCache: null,
        detectorStatus: "detector: no image",
        detectionGeneration: 0,
        automaticMatchingStatus: "automatic matching: not run",
        autoIdentifyBusy: false,
        luckyFitBusy: false,
        pendingMatch: null,
        centroidPreview: null,
        centroidDensity: null,
        matches: [],
        showPickedMatchMarkers: true,
        showKdePositionDots: false,
        showFitResiduals: false,
        showAsterismLines: true,
        asterismEdges: [],
        triangleDebugSnapshot: null,
        fitMessage: "lens fit: not run",
        lastFitVector: null,
        lastAcceptedFitVector: null,
        fitUndoStack: [],
        lastLensEquation: "",
        activeOptmod: Number(controls.optmod.value) || 2,
    };
    let detectorUpdateTimer = null;

    controls.timestampUtc.value = AidaTools.dateToDatetimeLocal(new Date());
    function shader(type, source) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, source);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(sh));
        }
        return sh;
    }

    function program(vs, fs) {
        const prg = gl.createProgram();
        gl.attachShader(prg, shader(gl.VERTEX_SHADER, vs));
        gl.attachShader(prg, shader(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(prg);
        if (!gl.getProgramParameter(prg, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(prg));
        }
        return prg;
    }

    const imageProgram = program(`
        attribute vec2 a_pos;
        attribute vec2 a_tex;
        varying vec2 v_tex;
        void main() {
            v_tex = a_tex;
            gl_Position = vec4(a_pos, 0.0, 1.0);
        }
    `, `
        precision mediump float;
        uniform sampler2D u_image;
        uniform float u_brightness;
        uniform float u_contrast;
        varying vec2 v_tex;
        void main() {
            vec4 color = texture2D(u_image, v_tex);
            color.rgb = (color.rgb - 0.5) * u_contrast + 0.5 + u_brightness;
            gl_FragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
        }
    `);

    const pointProgram = program(`
        attribute vec2 a_pixel;
        attribute float a_mag;
        uniform vec2 u_canvas_size;
        uniform float u_point_scale;
        uniform float u_max_mag;
        varying float v_mag;
        varying float v_alpha;
        void main() {
            vec2 clip = vec2(
                (a_pixel.x / u_canvas_size.x) * 2.0 - 1.0,
                1.0 - (a_pixel.y / u_canvas_size.y) * 2.0
            );
            gl_Position = vec4(clip, 0.0, 1.0);
            float size = 2.4 + 12.5 * pow(10.0, -0.13 * (a_mag + 1.0));
            gl_PointSize = clamp(size * u_point_scale, 2.5, 26.0 * u_point_scale);
            v_mag = a_mag;
            v_alpha = clamp(0.18 + 0.82 * (u_max_mag - a_mag + 0.5) / max(1.0, u_max_mag + 1.0), 0.16, 1.0);
        }
    `, `
        precision mediump float;
        varying float v_mag;
        varying float v_alpha;
        void main() {
            vec2 d = gl_PointCoord - vec2(0.5);
            float r = length(d);
            if (r > 0.5) discard;
            float core = exp(-r * r / 0.010);
            float halo = exp(-r * r / 0.085);
            float edge = smoothstep(0.5, 0.42, r);
            float alpha = clamp(2.30 * core + 0.84 * halo, 0.0, 1.0) * edge * v_alpha;
            vec3 coolWhite = vec3(0.78, 0.88, 1.0);
            vec3 warmWhite = vec3(1.0, 0.96, 0.84);
            vec3 color = mix(warmWhite, coolWhite, clamp((2.5 - v_mag) / 4.0, 0.0, 1.0));
            gl_FragColor = vec4(min(color * 2.0, vec3(1.0)), alpha);
        }
    `);

    const lineProgram = program(`
        attribute vec2 a_pixel;
        uniform vec2 u_canvas_size;
        void main() {
            vec2 clip = vec2(
                (a_pixel.x / u_canvas_size.x) * 2.0 - 1.0,
                1.0 - (a_pixel.y / u_canvas_size.y) * 2.0
            );
            gl_Position = vec4(clip, 0.0, 1.0);
        }
    `, `
        precision mediump float;
        uniform vec4 u_color;
        void main() {
            gl_FragColor = u_color;
        }
    `);

    const quadBuffer = gl.createBuffer();
    const pointBuffer = gl.createBuffer();
    const lineBuffer = gl.createBuffer();

    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function imageViewport() {
        if (!state.image) {
            return {x: 0, y: 0, w: canvas.width, h: canvas.height, scale: 1};
        }
        const scale = Math.min(canvas.width / state.image.width, canvas.height / state.image.height);
        const w = state.image.width * scale;
        const h = state.image.height * scale;
        return {x: (canvas.width - w) / 2, y: (canvas.height - h) / 2, w, h, scale};
    }

    function canvasPixelFromImagePixel(x, y) {
        const [ix, iy] = displayedImagePixelFromModelImagePixel(x, y);
        return canvasPixelFromDisplayedImagePixel(ix, iy);
    }

    function canvasPixelFromDisplayedImagePixel(x, y) {
        const vp = imageViewport();
        return [vp.x + x * vp.scale, vp.y + y * vp.scale];
    }

    function imageMarkerCanvasPixel(x, y) {
        if (!state.image) {
            return [NaN, NaN];
        }
        const [ix, iy] = displayedImagePixelFromRawImagePixel(x, y);
        return canvasPixelFromDisplayedImagePixel(ix, iy);
    }

    function displayedImagePixelFromRawImagePixel(x, y) {
        return [
            state.imageFlipX ? state.image.width - 1 - x : x,
            state.imageFlipY ? state.image.height - 1 - y : y,
        ];
    }

    function rawImagePixelFromDisplayedImagePixel(x, y) {
        return [
            state.imageFlipX ? state.image.width - 1 - x : x,
            state.imageFlipY ? state.image.height - 1 - y : y,
        ];
    }

    function displayedImagePixelFromModelImagePixel(x, y) {
        return [
            state.flipX ? state.image.width - 1 - x : x,
            state.flipY ? state.image.height - 1 - y : y,
        ];
    }

    function rawImagePixelFromModelImagePixel(x, y) {
        const [displayedX, displayedY] = displayedImagePixelFromModelImagePixel(x, y);
        return rawImagePixelFromDisplayedImagePixel(displayedX, displayedY);
    }

    function isMaskedImagePixel(x, y, pad = 0) {
        for (const region of state.maskRegions) {
            const r = region.radius + pad;
            const dx = x - region.x;
            const dy = y - region.y;
            if (dx * dx + dy * dy <= r * r) {
                return true;
            }
        }
        return false;
    }

    function isJunkStarFinderPixel(x, y, pad = 0) {
        if (isNotStarTilePixel(x, y, pad)) {
            return true;
        }
        for (const region of state.junkStarFinderRegions) {
            const r = region.radius + pad;
            const dx = x - region.x;
            const dy = y - region.y;
            if (dx * dx + dy * dy <= r * r) {
                return true;
            }
        }
        return false;
    }

    function isNotStarTilePixel(x, y, pad = 0) {
        for (const tile of state.notStarTiles) {
            if (x >= tile.x0 - pad && x < tile.x0 + tile.width + pad &&
                    y >= tile.y0 - pad && y < tile.y0 + tile.height + pad) {
                return true;
            }
        }
        return false;
    }

    function activeDetectedStars() {
        return state.detectedStars.filter(detection =>
            !state.deletedDetectionIds.has(detection.id) &&
            !isJunkStarFinderPixel(detection.x, detection.y)
        );
    }

    function eventToCanvasPixel(event) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return [(event.clientX - rect.left) * dpr, (event.clientY - rect.top) * dpr];
    }

    function eventToImagePixel(event) {
        if (!state.image) {
            return null;
        }
        const [cx, cy] = eventToCanvasPixel(event);
        const vp = imageViewport();
        let x = (cx - vp.x) / vp.scale;
        let y = (cy - vp.y) / vp.scale;
        if (x < 0 || x >= state.image.width || y < 0 || y >= state.image.height) {
            return null;
        }
        x = state.imageFlipX ? state.image.width - 1 - x : x;
        y = state.imageFlipY ? state.image.height - 1 - y : y;
        return {x, y};
    }

    function canvasPixelToCssPixel(point) {
        const dpr = window.devicePixelRatio || 1;
        return [point[0] / dpr, point[1] / dpr];
    }

    function clampCanvasPointToViewport(point, inset) {
        const vp = imageViewport();
        return [
            Math.min(vp.x + vp.w - inset, Math.max(vp.x + inset, point[0])),
            Math.min(vp.y + vp.h - inset, Math.max(vp.y + inset, point[1])),
        ];
    }

    function addOverlayLabel(text, backingPixel, className, clampToImage = false) {
        let point = backingPixel;
        const inset = 22 * (window.devicePixelRatio || 1);
        if (clampToImage) {
            point = clampCanvasPointToViewport(point, inset);
        }
        const [left, top] = canvasPixelToCssPixel(point);
        if (left < 0 || left > canvas.clientWidth || top < 0 || top > canvas.clientHeight) {
            return false;
        }
        const el = document.createElement("div");
        el.className = `cardinal-label ${className || ""}`.trim();
        el.textContent = text;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        cardinalLayer.appendChild(el);
        return true;
    }

    function addOverlayCircle(backingPixel, className = "") {
        const [left, top] = canvasPixelToCssPixel(backingPixel);
        if (left < 0 || left > canvas.clientWidth || top < 0 || top > canvas.clientHeight) {
            return false;
        }
        const el = document.createElement("div");
        el.className = `match-marker ${className}`.trim();
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        cardinalLayer.appendChild(el);
        return true;
    }

    function addOverlayRadiusCircle(rawX, rawY, radius, className = "") {
        if (!state.image) {
            return false;
        }
        const point = imageMarkerCanvasPixel(rawX, rawY);
        const [left, top] = canvasPixelToCssPixel(point);
        const vp = imageViewport();
        const dpr = window.devicePixelRatio || 1;
        const radiusCss = radius * vp.scale / dpr;
        if (left + radiusCss < 0 || left - radiusCss > canvas.clientWidth ||
                top + radiusCss < 0 || top - radiusCss > canvas.clientHeight) {
            return false;
        }
        const el = document.createElement("div");
        el.className = `radius-region-marker ${className}`.trim();
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${2 * radiusCss}px`;
        el.style.height = `${2 * radiusCss}px`;
        cardinalLayer.appendChild(el);
        return true;
    }

    function addOverlayRawRect(rawX, rawY, width, height, className = "") {
        if (!state.image) {
            return false;
        }
        const a = imageMarkerCanvasPixel(rawX, rawY);
        const b = imageMarkerCanvasPixel(rawX + width, rawY + height);
        const [left, top] = canvasPixelToCssPixel([Math.min(a[0], b[0]), Math.min(a[1], b[1])]);
        const [right, bottom] = canvasPixelToCssPixel([Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
        if (right < 0 || left > canvas.clientWidth || bottom < 0 || top > canvas.clientHeight) {
            return false;
        }
        const el = document.createElement("div");
        el.className = `raw-tile-marker ${className}`.trim();
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${Math.max(1, right - left)}px`;
        el.style.height = `${Math.max(1, bottom - top)}px`;
        cardinalLayer.appendChild(el);
        return true;
    }

    function addOverlaySvgLineLayer(edges, className = "") {
        if (!state.image || !Array.isArray(edges) || edges.length === 0) {
            return false;
        }
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", `asterism-line-layer ${className}`.trim());
        svg.setAttribute("viewBox", `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
        svg.setAttribute("preserveAspectRatio", "none");
        for (const edge of edges) {
            if (!edge || !edge.a || !edge.b) {
                continue;
            }
            const a = canvasPixelToCssPixel(imageMarkerCanvasPixel(edge.a.x, edge.a.y));
            const b = canvasPixelToCssPixel(imageMarkerCanvasPixel(edge.b.x, edge.b.y));
            if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) {
                continue;
            }
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", a[0].toFixed(2));
            line.setAttribute("y1", a[1].toFixed(2));
            line.setAttribute("x2", b[0].toFixed(2));
            line.setAttribute("y2", b[1].toFixed(2));
            if (edge.label) {
                const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
                title.textContent = edge.label;
                line.appendChild(title);
            }
            svg.appendChild(line);
        }
        if (svg.childNodes.length === 0) {
            return false;
        }
        cardinalLayer.appendChild(svg);
        return true;
    }

    function optparFromControls() {
        const optmod = Number(controls.optmod.value) || 2;
        const common = [
            Number(controls.fScaleX.value) || 1.0,
            Number(controls.fScaleY.value) || 1.0,
            Number(controls.rotAlpha.value) || 0,
            Number(controls.rotBeta.value) || 0,
            Number(controls.rotGamma.value) || 0,
            Number(controls.du.value) || 0,
            Number(controls.dv.value) || 0,
            Number.isFinite(Number(controls.radialAlpha.value)) ? Number(controls.radialAlpha.value) : 0.35,
        ];
        if (optmod !== BROWN_CONRADY_OPTMOD) {
            return common;
        }
        return common.concat([
            Number(controls.brownK2.value) || 0,
            Number(controls.brownK3.value) || 0,
            Number(controls.brownP1.value) || 0,
            Number(controls.brownP2.value) || 0,
        ]);
    }

    function currentOptpar() {
        const optmod = Number(controls.optmod.value) || 2;
        const requiredLength = requiredOptparLength(optmod);
        if (state && Array.isArray(state.modelOptpar) && state.modelOptpar.length >= requiredLength) {
            return state.modelOptpar.slice(0, requiredLength);
        }
        return optparFromControls();
    }

    function syncModelOptparFromControls() {
        state.modelOptpar = optparFromControls();
    }

    function isMacPlatform() {
        const platform = navigator.userAgentData && navigator.userAgentData.platform ?
            navigator.userAgentData.platform :
            navigator.platform;
        return /mac/i.test(platform || "");
    }

    function defaultRadialAlphaForOptmod(optmod = Number(controls.optmod.value) || 2) {
        if (optmod === BROWN_CONRADY_OPTMOD || optmod === 12) {
            return 0.0;
        }
        if (optmod === 1 || optmod === 4) {
            return 1.0;
        }
        if (optmod === 5) {
            return 0.5;
        }
        return 0.35;
    }

    function defaultOptparForImage(image = state.image, optmod = Number(controls.optmod.value) || 2) {
        const width = image && Number.isFinite(image.width) && image.width > 0 ? image.width : 16;
        const height = image && Number.isFinite(image.height) && image.height > 0 ? image.height : 9;
        const common = [1.0, width / height, 0, 0, 0, 0, 0, defaultRadialAlphaForOptmod(optmod)];
        return optmod === BROWN_CONRADY_OPTMOD ? common.concat([0, 0, 0, 0]) : common;
    }

    function cameraAnglesFromRotation(rot) {
        if (typeof AidaTools.cameraAnglesFromRotation === "function") {
            return AidaTools.cameraAnglesFromRotation(rot);
        }
        if (!Array.isArray(rot) || rot.length < 9) {
            return null;
        }
        const beta = Math.asin(Math.max(-1, Math.min(1, rot[5])));
        const cb = Math.cos(beta);
        let alpha = 0;
        let gamma = 0;
        if (Math.abs(cb) > 1e-9) {
            alpha = Math.atan2(rot[2], rot[8]);
            gamma = Math.atan2(rot[3], rot[4]);
        } else {
            gamma = Math.atan2(-rot[1], rot[0]);
        }
        return {
            alpha: alpha * 180 / Math.PI,
            beta: beta * 180 / Math.PI,
            gamma: gamma * 180 / Math.PI,
        };
    }

    function radialAlphaIsValidForOptmod(value, optmod = Number(controls.optmod.value) || 2) {
        if (!Number.isFinite(value)) {
            return false;
        }
        if (optmod === BROWN_CONRADY_OPTMOD) {
            return Math.abs(value) <= 5.0;
        }
        if (optmod === 12) {
            return Math.abs(value) <= 2.5;
        }
        return value >= 0.05 && value <= 2.5;
    }

    function optparFromFitVector(x) {
        return x.slice();
    }

    function currentFitVector() {
        return currentOptpar();
    }

    function fitVectorMaxAbsDiff(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return Infinity;
        }
        let maxDiff = 0;
        for (let i = 0; i < a.length; i++) {
            maxDiff = Math.max(maxDiff, Math.abs((Number(a[i]) || 0) - (Number(b[i]) || 0)));
        }
        return maxDiff;
    }

    function updateOptmodUi() {
        const optmod = Number(controls.optmod.value) || 2;
        const previousOptmod = state.activeOptmod;
        const optmodChanged = previousOptmod !== optmod;
        state.activeOptmod = optmod;
        controls.brownConradyParams.hidden = optmod !== BROWN_CONRADY_OPTMOD;
        if (optmodChanged) {
            state.baseOptpar = null;
            applyOptpar(defaultOptparForImage(state.image, optmod));
        } else if (!radialAlphaIsValidForOptmod(Number(controls.radialAlpha.value), optmod)) {
            controls.radialAlpha.value = defaultRadialAlphaForOptmod(optmod).toFixed(6);
            syncModelOptparFromControls();
        }
    }

    function toggleAzElGrid() {
        state.showAzElGrid = !state.showAzElGrid;
        controls.toggleAzElGrid.textContent = state.showAzElGrid ? "Hide az/el grid" : "Show az/el grid";
        playInteractionSound("mode");
        render();
    }

    function applyFitVector(x) {
        const optmod = Number(controls.optmod.value) || 2;
        const applied = x.slice(0, requiredOptparLength(optmod));
        applied[0] = x[0];
        applied[1] = x[1];
        applied[2] = Math.max(-90, Math.min(90, x[2]));
        applied[3] = Math.max(-90, Math.min(90, x[3]));
        applied[4] = wrapDegrees180(x[4]);
        applied[5] = Math.max(-0.5, Math.min(0.5, x[5]));
        applied[6] = Math.max(-0.5, Math.min(0.5, x[6]));
        applied[7] = optmod === BROWN_CONRADY_OPTMOD ?
            Math.max(-5.0, Math.min(5.0, x[7] || 0)) :
            optmod === 12 ?
                Math.max(-2.5, Math.min(2.5, x[7])) :
                Math.max(0.05, Math.min(2.5, x[7]));
        if (optmod === BROWN_CONRADY_OPTMOD) {
            applied[8] = Math.max(-5.0, Math.min(5.0, x[8] || 0));
            applied[9] = Math.max(-5.0, Math.min(5.0, x[9] || 0));
            applied[10] = Math.max(-1.0, Math.min(1.0, x[10] || 0));
            applied[11] = Math.max(-1.0, Math.min(1.0, x[11] || 0));
        }
        state.modelOptpar = applied.slice();
        controls.fScaleX.value = applied[0].toPrecision(12);
        controls.fScaleY.value = applied[1].toPrecision(12);
        controls.rotAlpha.value = applied[2].toPrecision(12);
        controls.rotBeta.value = applied[3].toPrecision(12);
        controls.rotGamma.value = applied[4].toPrecision(12);
        controls.du.value = applied[5].toPrecision(12);
        controls.dv.value = applied[6].toPrecision(12);
        controls.radialAlpha.value = applied[7].toPrecision(12);
        if (optmod === BROWN_CONRADY_OPTMOD) {
            controls.brownK2.value = applied[8].toPrecision(12);
            controls.brownK3.value = applied[9].toPrecision(12);
            controls.brownP1.value = applied[10].toPrecision(12);
            controls.brownP2.value = applied[11].toPrecision(12);
        }
    }

    function updateUndoFitButton() {
        controls.undoFit.disabled = state.fitUndoStack.length === 0;
        controls.undoFit.textContent = state.fitUndoStack.length > 0
            ? `Undo ${state.fitUndoStack.length}`
            : "Undo";
    }

    function rememberUndoState(snapshot) {
        state.fitUndoStack.push({
            ...snapshot,
            label: snapshot.label || "change",
        });
        if (state.fitUndoStack.length > 20) {
            state.fitUndoStack.shift();
        }
        updateUndoFitButton();
    }

    function rememberFitState(label) {
        rememberUndoState({
            optpar: currentOptpar(),
            label,
        });
    }

    function cloneMatches(matches = state.matches) {
        return matches.map(match => ({
            id: match.id,
            image: {...match.image},
            detectionId: match.detectionId,
            detectionGeneration: match.detectionGeneration,
            catalog: {...match.catalog},
        }));
    }

    function cloneAsterismEdges(edges = state.asterismEdges) {
        return edges.map(edge => ({
            a: {...edge.a},
            b: {...edge.b},
            label: edge.label || "",
        }));
    }

    function autoPairingUndoSnapshot(label) {
        return {
            optpar: currentOptpar(),
            matches: cloneMatches(),
            asterismEdges: cloneAsterismEdges(),
            label,
        };
    }

    function restoreStateSnapshot(snapshot) {
        if (!snapshot) {
            return;
        }
        if (snapshot.optpar) {
            applyFitVector(snapshot.optpar);
            state.lastFitVector = snapshot.optpar.slice();
            state.lastAcceptedFitVector = snapshot.optpar.slice();
        }
        if (snapshot.matches) {
            state.matches = cloneMatches(snapshot.matches);
            state.matches.forEach((match, index) => {
                match.id = index + 1;
            });
            updateAutoMatches();
        }
        if (snapshot.asterismEdges) {
            state.asterismEdges = cloneAsterismEdges(snapshot.asterismEdges);
        }
    }

    function clearFitUndoStack() {
        state.fitUndoStack = [];
        updateUndoFitButton();
    }

    function undoFit() {
        const previous = state.fitUndoStack.pop();
        if (!previous) {
            state.fitMessage = "undo fit: no previous fit available";
            updateUndoFitButton();
            render();
            return;
        }
        restoreStateSnapshot(previous);
        state.pendingMatch = null;
        state.showPickedMatchMarkers = false;
        state.fitMessage = `undo: restored state before ${previous.label}`;
        updateUndoFitButton();
        recomputeAndRender();
    }

    function applyOptpar(optpar) {
        if (!optpar || optpar.length < 8) {
            state.baseOptpar = null;
            const defaults = defaultOptparForImage();
            applyFitVector(defaults);
            updateOptmodUi();
            return;
        }
        state.baseOptpar = optpar.slice();
        applyFitVector(optpar);
    }

    function latexNumber(value, digits = 4) {
        if (!Number.isFinite(value)) {
            return "0";
        }
        const text = Number(value).toFixed(digits);
        return text.replace(/\.?0+$/, "") || "0";
    }

    function lensEquationLatex(optpar, optmod) {
        if (optmod === BROWN_CONRADY_OPTMOD) {
            return "\\[" +
                "\\begin{aligned}" +
                "\\mathbf{o}&=[f_1,f_2,\\alpha,\\beta,\\gamma,d_u,d_v,k_1,k_2,k_3,p_1,p_2]\\\\" +
                `&=[${optpar.map((value, idx) => latexNumber(value, idx >= 2 && idx <= 4 ? 3 : 5)).join(", ")}]` +
                "\\\\" +
                "x_n&=s_1/s_3,\\quad y_n=s_2/s_3,\\quad r^2=x_n^2+y_n^2\\\\" +
                "L(r)&=1+k_1r^2+k_2r^4+k_3r^6\\\\" +
                "x_d&=x_nL(r)+2p_1x_ny_n+p_2(r^2+2x_n^2)\\\\" +
                "y_d&=y_nL(r)+p_1(r^2+2y_n^2)+2p_2x_ny_n\\\\" +
                "x&=W\\left(f_1x_d+\\frac{1}{2}+d_u\\right)-1\\\\" +
                "y&=H\\left(f_2y_d+\\frac{1}{2}+d_v\\right)-1" +
                "\\end{aligned}" +
                "\\]";
        }
        const radial = {
            1: "q_1(\\theta)=\\tan\\theta",
            2: "q_2(\\theta)=\\sin(a_r\\theta)",
            3: "q_3(\\theta)=a_r\\theta+(1-a_r)\\tan\\theta",
            4: "q_4(\\theta)=\\theta^{a_r}",
            5: "q_5(\\theta)=\\tan(a_r\\theta)",
            12: "q_{12}(\\theta)=\\begin{cases}\\tan(a_r\\theta)/a_r,&a_r>0\\\\ \\theta,&a_r=0\\\\ \\sin(a_r\\theta)/a_r,&a_r<0\\end{cases}",
        }[optmod] || "q(\\theta)";
        return "\\[" +
            "\\begin{aligned}" +
            "\\mathbf{o}&=[f_1,f_2,\\alpha,\\beta,\\gamma,d_u,d_v,a_r]\\\\" +
            `&=[${optpar.map((value, idx) => latexNumber(value, idx >= 2 && idx <= 4 ? 3 : 5)).join(", ")}]` +
            "\\\\" +
            "\\theta&=\\tan^{-1}\\!\\left(\\frac{\\sqrt{s_1^2+s_2^2}}{s_3}\\right),\\quad " +
            radial + "\\\\" +
            "x&=W\\left(f_1\\frac{s_1}{\\sqrt{s_1^2+s_2^2}}q(\\theta)+\\frac{1}{2}+d_u\\right)-1\\\\" +
            "y&=H\\left(f_2\\frac{s_2}{\\sqrt{s_1^2+s_2^2}}q(\\theta)+\\frac{1}{2}+d_v\\right)-1" +
            "\\end{aligned}" +
            "\\]";
    }

    function updateLensEquation(optpar, optmod) {
        if (!lensEquation) {
            return;
        }
        const latex = lensEquationLatex(optpar, optmod);
        if (latex === state.lastLensEquation) {
            return;
        }
        state.lastLensEquation = latex;
        lensEquation.textContent = latex;
        if (window.MathJax && MathJax.typesetPromise) {
            MathJax.typesetPromise([lensEquation]).catch(() => {});
        }
    }

    function projectRotationPoint(point, scale, centerX, centerY) {
        const distance = 3.4;
        const z = point[2] + distance;
        return [
            centerX + point[0] / z * scale,
            centerY - point[1] / z * scale,
        ];
    }

    function drawRotationLine(ctx, a, b, color, width, scale, centerX, centerY) {
        const pa = projectRotationPoint(a, scale, centerX, centerY);
        const pb = projectRotationPoint(b, scale, centerX, centerY);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.stroke();
        return pb;
    }

    function drawRotationVisualization() {
        if (!rotationCanvas || !rotationContext) {
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const rect = rotationCanvas.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (rotationCanvas.width !== w || rotationCanvas.height !== h) {
            rotationCanvas.width = w;
            rotationCanvas.height = h;
        }
        const ctx = rotationContext;
        ctx.clearRect(0, 0, w, h);
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, "#ffffff");
        gradient.addColorStop(1, "#eef2f7");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
        const cx = w * 0.5;
        const cy = h * 0.56;
        const scale = Math.min(w, h) * 2.25;
        const rot = AidaTools.cameraRot(
            Number(controls.rotAlpha.value) || 0,
            Number(controls.rotBeta.value) || 0,
            Number(controls.rotGamma.value) || 0
        );
        const transform = p => [
            p[0] * rot[0] + p[1] * rot[1] + p[2] * rot[2],
            p[0] * rot[3] + p[1] * rot[4] + p[2] * rot[5],
            p[0] * rot[6] + p[1] * rot[7] + p[2] * rot[8],
        ];
        const bodyPoints = [
            [-0.46, -0.32, 0],
            [0.46, -0.32, 0],
            [0.46, 0.32, 0],
            [-0.46, 0.32, 0],
        ].map(transform).map(p => projectRotationPoint(p, scale, cx, cy));
        const nose = projectRotationPoint(transform([0, 0, 0.7]), scale, cx, cy);
        const center = projectRotationPoint(transform([0, 0, 0]), scale, cx, cy);
        ctx.fillStyle = "rgba(15, 23, 42, 0.10)";
        ctx.strokeStyle = "rgba(15, 23, 42, 0.55)";
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(bodyPoints[0][0], bodyPoints[0][1]);
        for (let i = 1; i < bodyPoints.length; i++) {
            ctx.lineTo(bodyPoints[i][0], bodyPoints[i][1]);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = "rgba(15, 23, 42, 0.35)";
        for (const p of bodyPoints) {
            ctx.beginPath();
            ctx.moveTo(p[0], p[1]);
            ctx.lineTo(nose[0], nose[1]);
            ctx.stroke();
        }
        ctx.fillStyle = "#111827";
        ctx.beginPath();
        ctx.arc(nose[0], nose[1], 3.5 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(15, 23, 42, 0.45)";
        ctx.beginPath();
        ctx.ellipse(center[0], center[1] + 0.34 * scale / 3.4, 0.20 * scale / 3.4, 0.06 * scale / 3.4, 0, 0, Math.PI * 2);
        ctx.fill();
        const axes = [
            {label: "x", color: "#dc2626", end: transform([0.82, 0, 0])},
            {label: "y", color: "#16a34a", end: transform([0, 0.82, 0])},
            {label: "z", color: "#2563eb", end: transform([0, 0, 0.95])},
        ];
        for (const axis of axes) {
            const end = drawRotationLine(ctx, transform([0, 0, 0]), axis.end, axis.color, 2.4 * dpr, scale, cx, cy);
            ctx.fillStyle = axis.color;
            ctx.font = `${11 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
            ctx.fillText(axis.label, end[0] + 4 * dpr, end[1] - 4 * dpr);
        }
        ctx.fillStyle = "#475569";
        ctx.font = `${10 * dpr}px system-ui, sans-serif`;
        ctx.fillText(
            `alpha ${Number(controls.rotAlpha.value || 0).toFixed(1)}  beta ${Number(controls.rotBeta.value || 0).toFixed(1)}  gamma ${Number(controls.rotGamma.value || 0).toFixed(1)}`,
            8 * dpr,
            h - 9 * dpr
        );
    }

    function pythonFloat(value) {
        if (!Number.isFinite(value)) {
            return "0.0";
        }
        return Number(value).toPrecision(12);
    }

    function optparPythonArrayText() {
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value) || 2;
        return `optpar = [${[optmod, ...optpar].map(pythonFloat).join(", ")}]`;
    }

    function selectedExportLanguage() {
        return controls.exportLanguage ? controls.exportLanguage.value : "python";
    }

    function optparArrayText(language = selectedExportLanguage()) {
        return window.AidaExportGenerators.optparArrayText(exportContext(), language);
    }

    function safeCaseId(value) {
        return String(value || "aida_case")
            .replace(/\.[^.]*$/, "")
            .replace(/[^A-Za-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "aida_case";
    }

    function residualRowsForMatches(matches) {
        if (!state.image || !Array.isArray(matches) || matches.length === 0) {
            return [];
        }
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const lat = Number(controls.latDeg.value) || 0;
        const lon = Number(controls.lonDeg.value) || 0;
        const optmod = Number(controls.optmod.value);
        const optpar = currentOptpar();
        const rows = [];
        for (const match of matches) {
            const azze = AidaTools.radecToAzZe(match.catalog.raHours, match.catalog.decDeg, date, lat, lon);
            const xy = AidaTools.cameraModel(azze.az, azze.ze, optpar, optmod, state.image.width, state.image.height);
            if (!Number.isFinite(xy.x) || !Number.isFinite(xy.y)) {
                continue;
            }
            const [rawX, rawY] = rawImagePixelFromModelImagePixel(xy.x, xy.y);
            const dx = rawX - match.image.x;
            const dy = rawY - match.image.y;
            rows.push({
                match,
                model: {x: rawX, y: rawY},
                dx,
                dy,
                r: Math.hypot(dx, dy),
            });
        }
        return rows;
    }

    function residualSummary(rows) {
        if (!rows.length) {
            return {
                count: 0,
                rmsPx: null,
                medianPx: null,
                maxPx: null,
                medianDxPx: null,
                medianDyPx: null,
            };
        }
        const sumR2 = rows.reduce((acc, row) => acc + row.r * row.r, 0);
        const sortedR = rows.map(row => row.r).sort((a, b) => a - b);
        return {
            count: rows.length,
            rmsPx: Math.sqrt(sumR2 / rows.length),
            medianPx: sortedR[Math.floor(sortedR.length / 2)],
            maxPx: sortedR[sortedR.length - 1],
            medianDxPx: median(rows.map(row => row.dx)),
            medianDyPx: median(rows.map(row => row.dy)),
        };
    }

    function currentTestCaseObject() {
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const optmod = Number(controls.optmod.value) || 2;
        const optpar = [optmod, ...currentOptpar()];
        const caseId = state.loadedTestCaseId || safeCaseId(state.imageName);
        const rows = residualRowsForMatches(state.matches);
        const residualByMatchId = new Map(rows.map(row => [row.match.id, row]));
        return {
            id: caseId,
            title: `${caseId} manual browser calibration`,
            image: state.imageName || "replace-with-image-file.png",
            width: state.image ? state.image.width : null,
            height: state.image ? state.image.height : null,
            timestampUtc: date.toISOString(),
            latDeg: Number(controls.latDeg.value) || 0,
            lonDeg: Number(controls.lonDeg.value) || 0,
            altM: Number(controls.altM.value) || 0,
            optpar,
            maxMag: Number(controls.maxMag.value) || 7,
            matchRadiusPx: 22,
            display: {
                flipX: state.flipX,
                flipY: state.flipY,
                imageFlipX: state.imageFlipX,
                imageFlipY: state.imageFlipY,
                highPassImage: controls.highPassImage.checked,
                highPassWidthPx: Number(controls.highPassWidth.value) || 0,
                brightness: Number(controls.brightness.value) || 0,
                contrast: Number(controls.contrast.value) || 1,
            },
            badStarFinderDetections: state.badStarFinderDetections.map((detection, index) => ({
                id: index + 1,
                x: detection.x,
                y: detection.y,
                sourceDetectionId: detection.sourceDetectionId || null,
                markedBy: detection.markedBy ? {
                    x: detection.markedBy.x,
                    y: detection.markedBy.y,
                    radius: detection.markedBy.radius,
                } : null,
            })),
            badStarFinderRegions: state.junkStarFinderRegions.map((region, index) => ({
                id: index + 1,
                x: region.x,
                y: region.y,
                radius: region.radius,
                detectionCount: Number(region.detectionCount) || 0,
            })),
            residual: residualSummary(rows),
            matches: state.matches.map(match => ({
                id: match.id,
                image: {
                    x: match.image.x,
                    y: match.image.y,
                    method: match.image.method || "manual",
                },
                residual: residualByMatchId.has(match.id) ? {
                    modelX: residualByMatchId.get(match.id).model.x,
                    modelY: residualByMatchId.get(match.id).model.y,
                    dx: residualByMatchId.get(match.id).dx,
                    dy: residualByMatchId.get(match.id).dy,
                    r: residualByMatchId.get(match.id).r,
                } : null,
                catalog: {
                    key: match.catalog.key,
                    name: match.catalog.name,
                    raHours: match.catalog.raHours,
                    decDeg: match.catalog.decDeg,
                    mag: match.catalog.mag,
                    az: match.catalog.az,
                    ze: match.catalog.ze,
                },
            })),
        };
    }

    function setSaveFeedback(message, isError = false) {
        if (!controls.saveFeedback) {
            return;
        }
        controls.saveFeedback.hidden = !message;
        controls.saveFeedback.textContent = message || "";
        controls.saveFeedback.classList.toggle("error", Boolean(isError));
    }

    function imagePixelsPngDataUrl() {
        if (!state.imagePixels || !state.image) {
            return Promise.resolve(null);
        }
        const imageCanvas = document.createElement("canvas");
        imageCanvas.width = state.image.width;
        imageCanvas.height = state.image.height;
        const imageContext = imageCanvas.getContext("2d");
        imageContext.putImageData(state.imagePixels, 0, 0);
        return new Promise(resolve => {
            imageCanvas.toBlob(blob => {
                if (!blob) {
                    resolve(null);
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            }, "image/png");
        });
    }

    async function submitCurrentTestCase() {
        if (!LOCAL_TEST_CASES_ENABLED) {
            return;
        }
        if (!state.image || !state.imagePixels) {
            state.fitMessage = "submit test case: load an image with readable pixels first";
            render();
            return;
        }
        if (state.matches.length === 0 && state.badStarFinderDetections.length === 0) {
            state.fitMessage = "submit test case: no picked stars or marked bad star finder detections";
            render();
            return;
        }
        if (!controls.submitTestCase) {
            return;
        }
        controls.submitTestCase.disabled = true;
        try {
            const testCase = currentTestCaseObject();
            const imageDataUrl = await imagePixelsPngDataUrl();
            const response = await fetch("/api/test-cases", {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({testCase, imageDataUrl}),
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || "server rejected test case");
            }
            state.loadedTestCaseId = result.caseId;
            setSaveFeedback(`${result.updated ? "Updated" : "Saved"} ${result.caseId}: ${result.metadata}`, false);
            state.fitMessage = `submit test case: ${result.updated ? "updated" : "saved"} ${result.caseId} ` +
                `with ${testCase.matches.length} star pairings and ` +
                `${testCase.badStarFinderDetections.length} bad star finder detections; ` +
                `metadata ${result.metadata}; image ${result.image}`;
            await refreshTestCaseList(result.caseId);
        } catch (error) {
            setSaveFeedback(`Save failed: ${error.message || error}`, true);
            state.fitMessage = `submit test case failed: ${error.message || error}. Start with npm run serve.`;
        } finally {
            controls.submitTestCase.disabled = false;
            render();
            focusImageWindowSoon();
        }
    }

    async function refreshTestCaseList(selectId = "") {
        if (!LOCAL_TEST_CASES_ENABLED || !controls.testCaseSelect) {
            return;
        }
        try {
            const response = await fetch("/api/test-cases");
            if (!response.ok) {
                throw new Error("test-case API unavailable");
            }
            const cases = await response.json();
            controls.testCaseSelect.replaceChildren();
            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = cases.length ? "Select saved test case..." : "No saved test cases";
            controls.testCaseSelect.appendChild(placeholder);
            for (const testCase of cases) {
                const option = document.createElement("option");
                option.value = testCase.id;
                option.textContent = `${testCase.id} (${testCase.matches || 0} stars)`;
                controls.testCaseSelect.appendChild(option);
            }
            controls.testCaseSelect.value = selectId || "";
        } catch (error) {
            controls.testCaseSelect.replaceChildren();
            const option = document.createElement("option");
            option.value = "";
            option.textContent = "Start with npm run serve";
            controls.testCaseSelect.appendChild(option);
        }
    }

    function restoreTestCaseState(testCase) {
        state.loadedTestCaseId = safeCaseId(testCase.id || testCase.image || "");
        const optpar = Array.isArray(testCase.optpar) ? testCase.optpar.map(Number) : [];
        const optmod = Number.isFinite(optpar[0]) ? Math.round(optpar[0]) : Number(testCase.optmod) || 2;
        controls.optmod.value = String(optmod);
        updateOptmodUi();
        applyOptpar(optpar.length > 1 ? optpar.slice(1) : null);
        if (testCase.timestampUtc || testCase.date) {
            const date = new Date(testCase.timestampUtc || testCase.date);
            if (!Number.isNaN(date.getTime())) {
                controls.timestampUtc.value = AidaTools.dateToDatetimeLocal(date);
            }
        }
        if (Number.isFinite(Number(testCase.latDeg))) {
            controls.latDeg.value = Number(testCase.latDeg).toFixed(6);
        }
        if (Number.isFinite(Number(testCase.lonDeg))) {
            controls.lonDeg.value = Number(testCase.lonDeg).toFixed(6);
        }
        if (Number.isFinite(Number(testCase.altM))) {
            controls.altM.value = String(Number(testCase.altM));
        }
        if (Number.isFinite(Number(testCase.maxMag))) {
            controls.maxMag.value = Number(testCase.maxMag).toFixed(1);
        }
        const display = testCase.display || {};
        state.flipX = Boolean(display.flipX);
        state.flipY = Boolean(display.flipY);
        state.imageFlipX = Boolean(display.imageFlipX);
        state.imageFlipY = Boolean(display.imageFlipY);
        controls.highPassImage.checked = display.highPassImage !== false;
        controls.highPassWidth.value = Number.isFinite(Number(display.highPassWidthPx)) ?
            String(Number(display.highPassWidthPx)) : "100";
        controls.brightness.value = Number.isFinite(Number(display.brightness)) ?
            String(Number(display.brightness)) : controls.brightness.value;
        controls.contrast.value = Number.isFinite(Number(display.contrast)) ?
            String(Number(display.contrast)) : controls.contrast.value;
        state.matches = Array.isArray(testCase.matches) ? testCase.matches.map((match, index) => ({
            id: Number.isFinite(Number(match.id)) ? Number(match.id) : index + 1,
            image: {
                x: Number(match.image && match.image.x) || 0,
                y: Number(match.image && match.image.y) || 0,
                method: match.image && match.image.method || "manual",
            },
            catalog: {
                key: match.catalog && match.catalog.key || `${match.catalog && match.catalog.name || "star"}-${index}`,
                name: match.catalog && match.catalog.name || "",
                raHours: Number(match.catalog && match.catalog.raHours) || 0,
                decDeg: Number(match.catalog && match.catalog.decDeg) || 0,
                mag: Number(match.catalog && match.catalog.mag) || 0,
                az: Number(match.catalog && match.catalog.az) || 0,
                ze: Number(match.catalog && match.catalog.ze) || 0,
            },
        })) : [];
        state.junkStarFinderRegions = Array.isArray(testCase.badStarFinderRegions) ?
            testCase.badStarFinderRegions.map(region => ({
                x: Number(region.x) || 0,
                y: Number(region.y) || 0,
                radius: Number(region.radius) || 100,
                detectionCount: Number(region.detectionCount) || 0,
            })) : [];
        state.badStarFinderDetections = Array.isArray(testCase.badStarFinderDetections) ?
            testCase.badStarFinderDetections.map((detection, index) => ({
                id: Number.isFinite(Number(detection.id)) ? Number(detection.id) : index + 1,
                x: Number(detection.x) || 0,
                y: Number(detection.y) || 0,
                sourceDetectionId: detection.sourceDetectionId || null,
                markedBy: detection.markedBy ? {
                    x: Number(detection.markedBy.x) || 0,
                    y: Number(detection.markedBy.y) || 0,
                    radius: Number(detection.markedBy.radius) || 100,
                } : null,
            })) : [];
        state.junkStarFinderPreview = null;
        state.junkStarFinderPaintActive = false;
        state.lastJunkStarFinderPoint = null;
        state.showPickedMatchMarkers = true;
        state.showFitResiduals = true;
        updateDetectionCircleButton();
        updateStarNameButton();
        updateFitResidualButton();
        updateAutoMatches();
        refreshDisplayImage();
        state.fitMessage = `loaded test case ${testCase.id || ""} with ${state.matches.length} star pairings`;
        setSaveFeedback(`Loaded ${testCase.id || "test case"}`, false);
    }

    async function loadSelectedTestCase() {
        if (!LOCAL_TEST_CASES_ENABLED) {
            return;
        }
        const id = controls.testCaseSelect && controls.testCaseSelect.value;
        if (!id) {
            setSaveFeedback("Select a saved test case first.", true);
            return;
        }
        controls.loadTestCase.disabled = true;
        try {
            const response = await fetch(`/api/test-cases/${encodeURIComponent(id)}`);
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || "failed to load test case");
            }
            resetForNewImage();
            loadImageSource(payload.imageUrl, payload.testCase.image || `${id}.png`, () => {
                restoreTestCaseState(payload.testCase);
            }, false, null, payload.testCase.image || `${id}.png`);
        } catch (error) {
            setSaveFeedback(`Load failed: ${error.message || error}`, true);
            state.fitMessage = `load test case failed: ${error.message || error}`;
            render();
        } finally {
            controls.loadTestCase.disabled = false;
            focusImageWindowSoon();
        }
    }

    function exportFunctionText(language = selectedExportLanguage()) {
        return window.AidaExportGenerators.mapperCode(exportContext(), language);
    }

    function exportContext() {
        return {
            optpar: currentOptpar(),
            optmod: Number(controls.optmod.value) || 2,
            width: state.image ? state.image.width : 1920,
            height: state.image ? state.image.height : 1080,
        };
    }

    function exportHeaderComment(language, inverseIncluded = false) {
        const context = exportContext();
        const note = inverseIncluded ?
            "Includes a numerical image_to_az_el inverse." :
            "Forward az_el_to_image export; invert numerically if image_to_az_el is needed.";
        if (language === "matlab") {
            return `% AIDA browser calibrator export. optmod=${context.optmod}, image ${context.width}x${context.height}. ${note}\n`;
        }
        if (language === "c") {
            return `/* AIDA browser calibrator export. optmod=${context.optmod}, image ${context.width}x${context.height}. ${note} */\n`;
        }
        return `# AIDA browser calibrator export. optmod=${context.optmod}, image ${context.width}x${context.height}. ${note}\n`;
    }

    function pythonImageToAzElFunctionText() {
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value) || 2;
        const width = state.image ? state.image.width : 1920;
        const height = state.image ? state.image.height : 1080;
        return `import numpy as np
from scipy.optimize import least_squares

optpar = np.array([${[optmod, ...optpar].map(pythonFloat).join(", ")}], dtype=float)
optmod = int(round(optpar[0]))
optpar = optpar[1:]
image_width = ${width}
image_height = ${height}

def _camera_rot(alpha_deg, beta_deg, gamma_deg):
    a = np.deg2rad(alpha_deg)
    b = np.deg2rad(beta_deg)
    g = np.deg2rad(gamma_deg)
    rot1 = np.array([[np.cos(g), -np.sin(g), 0.0],
                     [np.sin(g),  np.cos(g), 0.0],
                     [0.0,        0.0,       1.0]])
    rot2 = np.array([[ np.cos(a), 0.0, np.sin(a)],
                     [0.0,        1.0, 0.0],
                     [-np.sin(a), 0.0, np.cos(a)]])
    rot3 = np.array([[1.0, 0.0,       0.0],
                     [0.0, np.cos(b), np.sin(b)],
                     [0.0, -np.sin(b), np.cos(b)]])
    return rot2 @ rot3 @ rot1

def az_el_to_image(az_deg, el_deg, optpar=optpar, optmod=optmod,
                   width=image_width, height=image_height):
    az = np.deg2rad(az_deg)
    ze = np.deg2rad(90.0 - el_deg)
    rot = _camera_rot(optpar[2], optpar[3], optpar[4])
    sinze = np.sin(ze)
    es = np.array([sinze * np.sin(az), sinze * np.cos(az), np.cos(ze)])
    s1, s2, s3 = es @ rot
    radial = np.hypot(s1, s2)
    f1, f2, du, dv, radial_alpha = optpar[0], optpar[1], optpar[5], optpar[6], optpar[7]
    if radial <= 1e-12:
        u_norm = 0.5 + du
        v_norm = 0.5 + dv
    elif optmod == 1:
        safe_s3 = s3 if abs(s3) > 1e-12 else 1e-12
        u_norm = f1 * s1 / safe_s3 + 0.5 + du
        v_norm = f2 * s2 / safe_s3 + 0.5 + dv
    elif optmod == 2:
        theta = np.arctan2(radial, s3)
        r = np.sin(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif optmod == 3:
        theta = np.arctan2(radial, s3)
        safe_s3 = max(s3, 1e-12)
        u_norm = f1 * (1.0 - radial_alpha) * s1 / safe_s3 + f1 * radial_alpha * s1 / radial * theta + 0.5 + du
        v_norm = f2 * (1.0 - radial_alpha) * s2 / safe_s3 + f2 * radial_alpha * s2 / radial * theta + 0.5 + dv
    elif optmod == 4:
        theta = np.arctan2(radial, s3)
        r = abs(theta) ** radial_alpha
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif optmod == 5:
        theta = np.arctan2(radial, s3)
        r = np.tan(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif optmod == 12:
        theta = np.arctan2(radial, s3)
        if radial_alpha > 0:
            r = np.tan(radial_alpha * theta) / radial_alpha
        elif radial_alpha < 0:
            r = np.sin(radial_alpha * theta) / radial_alpha
        else:
            r = abs(theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif optmod == ${BROWN_CONRADY_OPTMOD}:
        safe_s3 = s3 if abs(s3) > 1e-12 else 1e-12
        xn = s1 / safe_s3
        yn = s2 / safe_s3
        r2 = xn * xn + yn * yn
        r4 = r2 * r2
        r6 = r4 * r2
        k1 = optpar[7] if len(optpar) > 7 else 0.0
        k2 = optpar[8] if len(optpar) > 8 else 0.0
        k3 = optpar[9] if len(optpar) > 9 else 0.0
        p1 = optpar[10] if len(optpar) > 10 else 0.0
        p2 = optpar[11] if len(optpar) > 11 else 0.0
        radial_distortion = 1.0 + k1 * r2 + k2 * r4 + k3 * r6
        x_distorted = xn * radial_distortion + 2.0 * p1 * xn * yn + p2 * (r2 + 2.0 * xn * xn)
        y_distorted = yn * radial_distortion + p1 * (r2 + 2.0 * yn * yn) + 2.0 * p2 * xn * yn
        u_norm = f1 * x_distorted + 0.5 + du
        v_norm = f2 * y_distorted + 0.5 + dv
    else:
        raise ValueError(f"unsupported optmod {optmod}")
    return np.array([u_norm * width - 1.0, v_norm * height - 1.0])

def image_to_az_el(x, y, optpar=optpar, optmod=optmod,
                   width=image_width, height=image_height):
    """Invert the fitted AIDA camera model for one image pixel.

    Returns (azimuth_deg, elevation_deg). Azimuth is wrapped to 0..360 deg.
    This numerical inverse is intended for calibrated all-sky pixels above
    the horizon; outside the fitted field of view the result can be ambiguous.
    """
    target = np.array([x, y], dtype=float)

    def residual(q):
        az_deg = q[0] % 360.0
        el_deg = q[1]
        return az_el_to_image(az_deg, el_deg, optpar, optmod, width, height) - target

    starts = [
        np.array([0.0, 90.0]),
        np.array([0.0, 60.0]),
        np.array([90.0, 60.0]),
        np.array([180.0, 60.0]),
        np.array([270.0, 60.0]),
        np.array([0.0, 25.0]),
        np.array([90.0, 25.0]),
        np.array([180.0, 25.0]),
        np.array([270.0, 25.0]),
    ]
    best = None
    for start in starts:
        result = least_squares(residual, start, bounds=([-720.0, 0.0], [720.0, 90.0]))
        err = np.linalg.norm(result.fun)
        if best is None or err < best[0]:
            best = (err, result.x)
    az_deg = best[1][0] % 360.0
    el_deg = best[1][1]
    return az_deg, el_deg
`;
    }

    function juliaMapperFunctionText() {
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value) || 2;
        const width = state.image ? state.image.width : 1920;
        const height = state.image ? state.image.height : 1080;
        return `${exportHeaderComment("julia")}${optparArrayText("julia")}
optmod = ${optmod}
image_width = ${width}
image_height = ${height}

function camera_rot(alpha_deg, beta_deg, gamma_deg)
    a = deg2rad(alpha_deg); b = deg2rad(beta_deg); g = deg2rad(gamma_deg)
    rot1 = [cos(g) -sin(g) 0.0; sin(g) cos(g) 0.0; 0.0 0.0 1.0]
    rot2 = [cos(a) 0.0 sin(a); 0.0 1.0 0.0; -sin(a) 0.0 cos(a)]
    rot3 = [1.0 0.0 0.0; 0.0 cos(b) sin(b); 0.0 -sin(b) cos(b)]
    return rot2 * rot3 * rot1
end

function az_el_to_image(az_deg, el_deg; optpar=optpar, optmod=optmod,
                        width=image_width, height=image_height)
    az = deg2rad(az_deg)
    ze = deg2rad(90.0 - el_deg)
    rot = camera_rot(optpar[3], optpar[4], optpar[5])
    sinze = sin(ze)
    es = [sinze * sin(az), sinze * cos(az), cos(ze)]
    s1, s2, s3 = es' * rot
    radial = hypot(s1, s2)
    f1, f2, du, dv, radial_alpha = optpar[1], optpar[2], optpar[6], optpar[7], optpar[8]
    if radial <= 1e-12
        u_norm = 0.5 + du; v_norm = 0.5 + dv
    elseif optmod == 1
        safe_s3 = abs(s3) > 1e-12 ? s3 : 1e-12
        u_norm = f1 * s1 / safe_s3 + 0.5 + du
        v_norm = f2 * s2 / safe_s3 + 0.5 + dv
    elseif optmod == 2
        theta = atan(radial, s3); r = sin(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elseif optmod == 3
        theta = atan(radial, s3); safe_s3 = max(s3, 1e-12)
        u_norm = f1 * (1.0 - radial_alpha) * s1 / safe_s3 + f1 * radial_alpha * s1 / radial * theta + 0.5 + du
        v_norm = f2 * (1.0 - radial_alpha) * s2 / safe_s3 + f2 * radial_alpha * s2 / radial * theta + 0.5 + dv
    elseif optmod == 4
        theta = atan(radial, s3); r = abs(theta) ^ radial_alpha
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elseif optmod == 5
        theta = atan(radial, s3); r = tan(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elseif optmod == 12
        theta = atan(radial, s3)
        r = radial_alpha > 0 ? tan(radial_alpha * theta) / radial_alpha :
            radial_alpha < 0 ? sin(radial_alpha * theta) / radial_alpha : abs(theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elseif optmod == ${BROWN_CONRADY_OPTMOD}
        safe_s3 = abs(s3) > 1e-12 ? s3 : 1e-12
        xn = s1 / safe_s3; yn = s2 / safe_s3
        r2 = xn*xn + yn*yn; r4 = r2*r2; r6 = r4*r2
        k1 = optpar[8]; k2 = optpar[9]; k3 = optpar[10]; p1 = optpar[11]; p2 = optpar[12]
        L = 1.0 + k1*r2 + k2*r4 + k3*r6
        xd = xn*L + 2.0*p1*xn*yn + p2*(r2 + 2.0*xn*xn)
        yd = yn*L + p1*(r2 + 2.0*yn*yn) + 2.0*p2*xn*yn
        u_norm = f1 * xd + 0.5 + du
        v_norm = f2 * yd + 0.5 + dv
    else
        error("unsupported optmod")
    end
    return (u_norm * width - 1.0, v_norm * height - 1.0)
end
`;
    }

    function cMapperFunctionText() {
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value) || 2;
        const width = state.image ? state.image.width : 1920;
        const height = state.image ? state.image.height : 1080;
        return `${exportHeaderComment("c")}#include <math.h>
${optparArrayText("c")}
static const int optmod = ${optmod};
static const double image_width = ${pythonFloat(width)};
static const double image_height = ${pythonFloat(height)};

static void camera_rot(double alpha_deg, double beta_deg, double gamma_deg, double rot[9]) {
    double a = alpha_deg * M_PI / 180.0, b = beta_deg * M_PI / 180.0, g = gamma_deg * M_PI / 180.0;
    double rot1[9] = {cos(g), -sin(g), 0, sin(g), cos(g), 0, 0, 0, 1};
    double rot2[9] = {cos(a), 0, sin(a), 0, 1, 0, -sin(a), 0, cos(a)};
    double rot3[9] = {1, 0, 0, 0, cos(b), sin(b), 0, -sin(b), cos(b)};
    double tmp[9];
    for (int r = 0; r < 3; r++) for (int c = 0; c < 3; c++) tmp[3*r+c] = rot2[3*r+0]*rot3[c] + rot2[3*r+1]*rot3[3+c] + rot2[3*r+2]*rot3[6+c];
    for (int r = 0; r < 3; r++) for (int c = 0; c < 3; c++) rot[3*r+c] = tmp[3*r+0]*rot1[c] + tmp[3*r+1]*rot1[3+c] + tmp[3*r+2]*rot1[6+c];
}

void aida_az_el_to_image(double az_deg, double el_deg, double *x, double *y) {
    double rot[9]; camera_rot(optpar[2], optpar[3], optpar[4], rot);
    double az = az_deg * M_PI / 180.0, ze = (90.0 - el_deg) * M_PI / 180.0;
    double sinze = sin(ze);
    double es1 = sinze * sin(az), es2 = sinze * cos(az), es3 = cos(ze);
    double s1 = es1*rot[0] + es2*rot[3] + es3*rot[6];
    double s2 = es1*rot[1] + es2*rot[4] + es3*rot[7];
    double s3 = es1*rot[2] + es2*rot[5] + es3*rot[8];
    double f1 = optpar[0], f2 = optpar[1], du = optpar[5], dv = optpar[6], radial_alpha = optpar[7];
    double radial = hypot(s1, s2), u_norm, v_norm;
    if (radial <= 1e-12) { u_norm = 0.5 + du; v_norm = 0.5 + dv; }
    else if (optmod == 1) { double ss3 = fabs(s3) > 1e-12 ? s3 : 1e-12; u_norm = f1*s1/ss3 + 0.5 + du; v_norm = f2*s2/ss3 + 0.5 + dv; }
    else if (optmod == 2) { double theta = atan2(radial, s3), rr = sin(radial_alpha*theta); u_norm = f1*s1/radial*rr + 0.5 + du; v_norm = f2*s2/radial*rr + 0.5 + dv; }
    else if (optmod == 3) { double theta = atan2(radial, s3), ss3 = fmax(s3, 1e-12); u_norm = f1*(1.0-radial_alpha)*s1/ss3 + f1*radial_alpha*s1/radial*theta + 0.5 + du; v_norm = f2*(1.0-radial_alpha)*s2/ss3 + f2*radial_alpha*s2/radial*theta + 0.5 + dv; }
    else if (optmod == 4) { double theta = atan2(radial, s3), rr = pow(fabs(theta), radial_alpha); u_norm = f1*s1/radial*rr + 0.5 + du; v_norm = f2*s2/radial*rr + 0.5 + dv; }
    else if (optmod == 5) { double theta = atan2(radial, s3), rr = tan(radial_alpha*theta); u_norm = f1*s1/radial*rr + 0.5 + du; v_norm = f2*s2/radial*rr + 0.5 + dv; }
    else if (optmod == 12) { double theta = atan2(radial, s3), rr = radial_alpha > 0 ? tan(radial_alpha*theta)/radial_alpha : (radial_alpha < 0 ? sin(radial_alpha*theta)/radial_alpha : fabs(theta)); u_norm = f1*s1/radial*rr + 0.5 + du; v_norm = f2*s2/radial*rr + 0.5 + dv; }
    else {
        double ss3 = fabs(s3) > 1e-12 ? s3 : 1e-12, xn = s1/ss3, yn = s2/ss3;
        double r2 = xn*xn + yn*yn, r4 = r2*r2, r6 = r4*r2;
        double k1 = optpar[7], k2 = optpar[8], k3 = optpar[9], p1 = optpar[10], p2 = optpar[11];
        double L = 1.0 + k1*r2 + k2*r4 + k3*r6;
        double xd = xn*L + 2.0*p1*xn*yn + p2*(r2 + 2.0*xn*xn);
        double yd = yn*L + p1*(r2 + 2.0*yn*yn) + 2.0*p2*xn*yn;
        u_norm = f1*xd + 0.5 + du; v_norm = f2*yd + 0.5 + dv;
    }
    *x = u_norm * image_width - 1.0; *y = v_norm * image_height - 1.0;
}
`;
    }

    function matlabMapperFunctionText() {
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value) || 2;
        const width = state.image ? state.image.width : 1920;
        const height = state.image ? state.image.height : 1080;
        return `${exportHeaderComment("matlab")}${optparArrayText("matlab")}
optmod = ${optmod};
image_width = ${width};
image_height = ${height};

function [x, y] = az_el_to_image(az_deg, el_deg, optpar, optmod, width, height)
if nargin < 3, optpar = evalin('base','optpar'); end
if nargin < 4, optmod = evalin('base','optmod'); end
if nargin < 5, width = evalin('base','image_width'); height = evalin('base','image_height'); end
a=deg2rad(optpar(3)); b=deg2rad(optpar(4)); g=deg2rad(optpar(5));
rot1=[cos(g) -sin(g) 0; sin(g) cos(g) 0; 0 0 1];
rot2=[cos(a) 0 sin(a); 0 1 0; -sin(a) 0 cos(a)];
rot3=[1 0 0; 0 cos(b) sin(b); 0 -sin(b) cos(b)];
rot=rot2*rot3*rot1;
az=deg2rad(az_deg); ze=deg2rad(90-el_deg); sinze=sin(ze);
es=[sinze*sin(az), sinze*cos(az), cos(ze)];
s=es*rot; s1=s(1); s2=s(2); s3=s(3); radial=hypot(s1,s2);
f1=optpar(1); f2=optpar(2); du=optpar(6); dv=optpar(7); ar=optpar(8);
if radial <= 1e-12
    u=0.5+du; v=0.5+dv;
elseif optmod == 1
    ss3=max(abs(s3),1e-12)*sign(s3 + (s3==0)); u=f1*s1/ss3+0.5+du; v=f2*s2/ss3+0.5+dv;
elseif optmod == 2
    theta=atan2(radial,s3); rr=sin(ar*theta); u=f1*s1/radial*rr+0.5+du; v=f2*s2/radial*rr+0.5+dv;
elseif optmod == 3
    theta=atan2(radial,s3); ss3=max(s3,1e-12); u=f1*(1-ar)*s1/ss3+f1*ar*s1/radial*theta+0.5+du; v=f2*(1-ar)*s2/ss3+f2*ar*s2/radial*theta+0.5+dv;
elseif optmod == 4
    theta=atan2(radial,s3); rr=abs(theta)^ar; u=f1*s1/radial*rr+0.5+du; v=f2*s2/radial*rr+0.5+dv;
elseif optmod == 5
    theta=atan2(radial,s3); rr=tan(ar*theta); u=f1*s1/radial*rr+0.5+du; v=f2*s2/radial*rr+0.5+dv;
elseif optmod == 12
    theta=atan2(radial,s3); if ar>0, rr=tan(ar*theta)/ar; elseif ar<0, rr=sin(ar*theta)/ar; else, rr=abs(theta); end
    u=f1*s1/radial*rr+0.5+du; v=f2*s2/radial*rr+0.5+dv;
else
    ss3=max(abs(s3),1e-12)*sign(s3 + (s3==0)); xn=s1/ss3; yn=s2/ss3; r2=xn*xn+yn*yn; r4=r2*r2; r6=r4*r2;
    k1=optpar(8); k2=optpar(9); k3=optpar(10); p1=optpar(11); p2=optpar(12);
    L=1+k1*r2+k2*r4+k3*r6; xd=xn*L+2*p1*xn*yn+p2*(r2+2*xn*xn); yd=yn*L+p1*(r2+2*yn*yn)+2*p2*xn*yn;
    u=f1*xd+0.5+du; v=f2*yd+0.5+dv;
end
x=u*width-1; y=v*height-1;
end
`;
    }

    function copyTextToClipboard(text, label) {
        const done = () => {
            state.fitMessage = `${label} copied to clipboard`;
            render();
        };
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(done).catch(() => {
                fallbackCopyText(text);
                done();
            });
            return;
        }
        fallbackCopyText(text);
        done();
    }

    function fallbackCopyText(text) {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
    }

    function clamp(value, lo, hi) {
        return Math.max(lo, Math.min(hi, value));
    }

    function boresightAzElFromCameraAngles(alphaDeg, betaDeg) {
        const alpha = alphaDeg * AidaTools.DEG;
        const beta = betaDeg * AidaTools.DEG;
        const x = Math.sin(alpha) * Math.cos(beta);
        const y = Math.sin(beta);
        const z = Math.cos(alpha) * Math.cos(beta);
        const az = ((Math.atan2(x, y) * AidaTools.RAD) % 360 + 360) % 360;
        const el = Math.asin(clamp(z, -1, 1)) * AidaTools.RAD;
        return {az, el};
    }

    function setCameraAnglesFromBoresightAzEl(azDeg, elDeg) {
        const az = azDeg * AidaTools.DEG;
        const el = elDeg * AidaTools.DEG;
        const cosEl = Math.cos(el);
        const x = cosEl * Math.sin(az);
        const y = cosEl * Math.cos(az);
        const z = Math.sin(el);
        controls.rotAlpha.value = (Math.atan2(x, z) * AidaTools.RAD).toPrecision(12);
        controls.rotBeta.value = (Math.asin(clamp(y, -1, 1)) * AidaTools.RAD).toPrecision(12);
    }

    function optparWithCameraAngles(alphaDeg, betaDeg, gammaDeg) {
        const optpar = currentOptpar();
        optpar[2] = alphaDeg;
        optpar[3] = betaDeg;
        optpar[4] = gammaDeg;
        return optpar;
    }

    function zenithCanvasPixelForCameraAngles(alphaDeg, betaDeg, gammaDeg) {
        if (!state.image) {
            return null;
        }
        return projectAzEl(
            0,
            90,
            optparWithCameraAngles(alphaDeg, betaDeg, gammaDeg),
            Number(controls.optmod.value),
            false
        );
    }

    function solveCameraAnglesForZenithPixel(targetPixel, startAlphaDeg, startBetaDeg, gammaDeg) {
        let alpha = startAlphaDeg;
        let beta = startBetaDeg;
        let bestAlpha = alpha;
        let bestBeta = beta;
        let bestError2 = Infinity;
        const h = 0.02;

        for (let iter = 0; iter < 12; iter++) {
            const p = zenithCanvasPixelForCameraAngles(alpha, beta, gammaDeg);
            if (!p) {
                break;
            }
            const rx = p[0] - targetPixel[0];
            const ry = p[1] - targetPixel[1];
            const err2 = rx * rx + ry * ry;
            if (err2 < bestError2) {
                bestAlpha = alpha;
                bestBeta = beta;
                bestError2 = err2;
            }
            if (Math.sqrt(err2) < 0.05) {
                break;
            }

            const pa = zenithCanvasPixelForCameraAngles(alpha + h, beta, gammaDeg);
            const pb = zenithCanvasPixelForCameraAngles(alpha, beta + h, gammaDeg);
            if (!pa || !pb) {
                break;
            }

            const j11 = (pa[0] - p[0]) / h;
            const j21 = (pa[1] - p[1]) / h;
            const j12 = (pb[0] - p[0]) / h;
            const j22 = (pb[1] - p[1]) / h;
            const det = j11 * j22 - j12 * j21;
            if (Math.abs(det) < 1e-9) {
                break;
            }

            let dAlpha = (-rx * j22 + j12 * ry) / det;
            let dBeta = (-j11 * ry + rx * j21) / det;
            const step = Math.hypot(dAlpha, dBeta);
            if (step > 8) {
                dAlpha *= 8 / step;
                dBeta *= 8 / step;
            }
            alpha = wrapDegrees180(alpha + dAlpha);
            beta = clamp(beta + dBeta, -89.9, 89.9);
        }

        const finalPoint = zenithCanvasPixelForCameraAngles(alpha, beta, gammaDeg);
        if (finalPoint) {
            const finalRx = finalPoint[0] - targetPixel[0];
            const finalRy = finalPoint[1] - targetPixel[1];
            const finalError2 = finalRx * finalRx + finalRy * finalRy;
            if (finalError2 < bestError2) {
                bestAlpha = alpha;
                bestBeta = beta;
                bestError2 = finalError2;
            }
        }

        controls.rotAlpha.value = bestAlpha.toPrecision(12);
        controls.rotBeta.value = bestBeta.toPrecision(12);
        return Math.sqrt(bestError2);
    }

    function catalogKey(star) {
        return `${star.name}|${star.raHours.toFixed(7)}|${star.decDeg.toFixed(7)}`;
    }

    function isMatchedCatalogStar(star) {
        const key = catalogKey(star);
        return state.matches.some(match => match.catalog.key === key);
    }

    function fittingMatches() {
        const maxMag = Number(controls.maxMag.value) || 4;
        return state.matches.filter(match => match.catalog.mag <= maxMag);
    }

    function updateProjection() {
        if (!state.image) {
            state.projected = [];
            state.autoMatches = [];
            return;
        }
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const lat = Number(controls.latDeg.value) || 0;
        const lon = Number(controls.lonDeg.value) || 0;
        const stars = AidaTools.visibleStars(window.AIDA_STAR_CATALOG, date, lat, lon, 7, 88);
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value);
        state.projected = [];
        for (const star of stars) {
            const xy = AidaTools.cameraModel(star.az, star.ze, optpar, optmod, state.image.width, state.image.height);
            if (Number.isFinite(xy.x) && Number.isFinite(xy.y)) {
                state.projected.push({...star, x: xy.x, y: xy.y});
            }
        }
        updateAutoMatches();
    }

    function updateAutoMatches() {
        state.autoMatches = [];
        if (!state.image || state.projected.length === 0 || state.detectedStars.length === 0) {
            return;
        }
        const radiusPx = 28;
        const radius2 = radiusPx * radiusPx;
        const usedDetections = new Set();
        const projected = state.projected
            .filter(star => !isMatchedCatalogStar(star))
            .slice()
            .sort((a, b) => a.mag - b.mag);
        const detections = activeDetectedStars();

        for (const star of projected) {
            const [rawX, rawY] = rawImagePixelFromModelImagePixel(star.x, star.y);
            let best = null;
            let bestD2 = Infinity;
            for (const detection of detections) {
                if (usedDetections.has(detection.id)) {
                    continue;
                }
                const dx = detection.x - rawX;
                const dy = detection.y - rawY;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2) {
                    best = detection;
                    bestD2 = d2;
                }
            }
            if (best && bestD2 <= radius2) {
                usedDetections.add(best.id);
                state.autoMatches.push({
                    star,
                    detection: best,
                    modelRawX: rawX,
                    modelRawY: rawY,
                    distance: Math.sqrt(bestD2),
                });
            }
        }
    }

    function projectedStarsForAutoIdentification() {
        return state.projected.map(star => {
            const [rawX, rawY] = rawImagePixelFromModelImagePixel(star.x, star.y);
            return {
                ...star,
                x: rawX,
                y: rawY,
                key: catalogKey(star),
            };
        });
    }

    function visibleStarsForMatching(maxMag) {
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const lat = Number(controls.latDeg.value) || 0;
        const lon = Number(controls.lonDeg.value) || 0;
        return AidaTools.visibleStars(window.AIDA_STAR_CATALOG, date, lat, lon, maxMag, 88)
            .map(star => ({...star, key: catalogKey(star)}));
    }

    function angularSeparationRad(a, b) {
        const sinZa = Math.sin(a.ze);
        const sinZb = Math.sin(b.ze);
        const dot = sinZa * sinZb * Math.cos(a.az - b.az) + Math.cos(a.ze) * Math.cos(b.ze);
        return Math.acos(Math.max(-1, Math.min(1, dot)));
    }

    function pruneCatalogByAngularSeparation(stars, minSeparationDeg) {
        if (!Number.isFinite(minSeparationDeg) || minSeparationDeg <= 0) {
            return stars;
        }
        const minSeparationRad = minSeparationDeg * AidaTools.DEG;
        const kept = [];
        for (const star of stars.slice().sort((a, b) => a.mag - b.mag || catalogKey(a).localeCompare(catalogKey(b)))) {
            if (kept.some(existing => angularSeparationRad(star, existing) < minSeparationRad)) {
                continue;
            }
            kept.push(star);
        }
        return kept;
    }

    function skyPlaneStarsForAsterismIdentification(maxMag, options = {}) {
        return pruneCatalogByAngularSeparation(
            visibleStarsForMatching(maxMag),
            options.minSeparationDeg
        )
            .map(star => {
                const r = star.ze / (Math.PI / 2);
                return {
                    ...star,
                    x: r * Math.sin(star.az),
                    y: -r * Math.cos(star.az),
                    key: catalogKey(star),
                };
            });
    }

    function autoIdentifierAvailable() {
        return Boolean(window.AidaAutoIdentifier &&
            typeof window.AidaAutoIdentifier.identifyStars === "function" &&
            typeof window.AidaAutoIdentifier.identifyStarsByAsterisms === "function" &&
            typeof window.AidaAutoIdentifier.identifyStarsBlind === "function");
    }

    function currentGenerationDetectionIdsFromMatches() {
        return new Set(
            state.matches
                .filter(match =>
                    match.detectionId !== null && match.detectionId !== undefined &&
                    match.detectionGeneration === state.detectionGeneration
                )
                .map(match => match.detectionId)
        );
    }

    function imagePointAlreadyMatched(x, y, radiusPx = 7) {
        const radius2 = radiusPx * radiusPx;
        return state.matches.some(match => {
            const dx = match.image.x - x;
            const dy = match.image.y - y;
            return dx * dx + dy * dy <= radius2;
        });
    }

    function projectedRawPointForCatalogKey(key, fallbackStar = null) {
        if (fallbackStar && Number.isFinite(fallbackStar.x) && Number.isFinite(fallbackStar.y)) {
            return {x: fallbackStar.x, y: fallbackStar.y};
        }
        const projected = state.projected.find(star => catalogKey(star) === key);
        if (!projected) {
            return null;
        }
        const [x, y] = rawImagePixelFromModelImagePixel(projected.x, projected.y);
        return Number.isFinite(x) && Number.isFinite(y) ? {x, y} : null;
    }

    function triangleShapeSignature(points) {
        if (!Array.isArray(points) || points.length !== 3 ||
                !points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) {
            return null;
        }
        const sides = [
            Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
            Math.hypot(points[1].x - points[2].x, points[1].y - points[2].y),
            Math.hypot(points[2].x - points[0].x, points[2].y - points[0].y),
        ].sort((a, b) => a - b);
        const longest = sides[2];
        if (!Number.isFinite(longest) || longest <= 1e-6) {
            return null;
        }
        const area2 = Math.abs(
            (points[1].x - points[0].x) * (points[2].y - points[0].y) -
            (points[2].x - points[0].x) * (points[1].y - points[0].y)
        );
        return {
            x: sides[0] / longest,
            y: sides[1] / longest,
            shortest: sides[0],
            longest,
            height: area2 / longest,
        };
    }

    function trianglePassesAsterismGeometry(signature) {
        if (!signature || !state.image) {
            return false;
        }
        return signature.shortest >= 50 &&
            signature.longest <= 0.25 * state.image.width &&
            signature.height >= 20;
    }

    function newMatchAsterismSupportCount(candidateMatch, existingMatches, options = {}) {
        const required = Number.isFinite(options.minAsterismChecksForNewStars) ?
            Math.max(0, Math.floor(options.minAsterismChecksForNewStars)) : 0;
        if (required <= 0) {
            return required;
        }
        if (!candidateMatch || !candidateMatch.star || !candidateMatch.detection || existingMatches.length < 2) {
            return 0;
        }
        const candidateObserved = {x: candidateMatch.detection.x, y: candidateMatch.detection.y};
        const candidateProjected = projectedRawPointForCatalogKey(candidateMatch.star.key, candidateMatch.star);
        if (!candidateProjected) {
            return 0;
        }
        const maxPartners = Number.isFinite(options.maxAsterismCheckPartners) ?
            Math.max(2, Math.floor(options.maxAsterismCheckPartners)) : 24;
        const tolerance = Number.isFinite(options.newStarAsterismSignatureTolerance) ?
            options.newStarAsterismSignatureTolerance : 0.035;
        const partners = existingMatches
            .map(match => ({
                observed: match.image,
                projected: projectedRawPointForCatalogKey(match.catalog.key),
                mag: Number(match.catalog.mag),
            }))
            .filter(match => match.observed && match.projected &&
                Number.isFinite(match.observed.x) && Number.isFinite(match.observed.y))
            .sort((a, b) => a.mag - b.mag)
            .slice(0, maxPartners);
        let support = 0;
        for (let i = 0; i < partners.length - 1; i += 1) {
            for (let j = i + 1; j < partners.length; j += 1) {
                const observedSignature = triangleShapeSignature([
                    candidateObserved,
                    partners[i].observed,
                    partners[j].observed,
                ]);
                const projectedSignature = triangleShapeSignature([
                    candidateProjected,
                    partners[i].projected,
                    partners[j].projected,
                ]);
                if (!trianglePassesAsterismGeometry(observedSignature) ||
                        !trianglePassesAsterismGeometry(projectedSignature)) {
                    continue;
                }
                const distance = Math.hypot(
                    observedSignature.x - projectedSignature.x,
                    observedSignature.y - projectedSignature.y
                );
                if (distance <= tolerance) {
                    support += 1;
                    if (support >= required) {
                        return support;
                    }
                }
            }
        }
        return support;
    }

    function addAutoIdentificationMatches(result, methodLabel = "auto star finder", options = {}) {
        const existingCatalogKeys = new Set(state.matches.map(match => match.catalog.key));
        const existingDetectionIds = currentGenerationDetectionIdsFromMatches();
        const trustedMatches = state.matches.slice();
        const maxAddDistancePx = Number.isFinite(options.maxAddDistancePx) ?
            options.maxAddDistancePx :
            Infinity;
        const ignoreDistanceGuards = options.ignoreDistanceGuards === true;
        if (!ignoreDistanceGuards && Number.isFinite(options.maxMedianDistance) &&
                Number.isFinite(result.medianDistance) &&
                result.medianDistance > options.maxMedianDistance) {
            return 0;
        }
        const maxAdditions = Number.isFinite(options.maxAdditions) ?
            Math.max(0, Math.floor(options.maxAdditions)) :
            Infinity;
        let added = 0;
        for (const match of result.matches || []) {
            if (added >= maxAdditions) {
                break;
            }
            if (!ignoreDistanceGuards && Number.isFinite(match.distance) && match.distance > maxAddDistancePx) {
                continue;
            }
            if (existingCatalogKeys.has(match.star.key) ||
                    existingDetectionIds.has(match.detection.id) ||
                    imagePointAlreadyMatched(match.detection.x, match.detection.y) ||
                    isJunkStarFinderPixel(match.detection.x, match.detection.y)) {
                continue;
            }
            const supportCount = newMatchAsterismSupportCount(match, trustedMatches, options);
            if (Number.isFinite(options.minAsterismChecksForNewStars) &&
                    supportCount < options.minAsterismChecksForNewStars) {
                continue;
            }
            const addedMatch = {
                id: state.matches.length + 1,
                image: {
                    x: match.detection.x,
                    y: match.detection.y,
                    method: methodLabel,
                },
                detectionId: match.detection.id,
                detectionGeneration: match.detection.generation || state.detectionGeneration,
                catalog: {
                    key: match.star.key,
                    raHours: match.star.raHours,
                    decDeg: match.star.decDeg,
                    mag: match.star.mag,
                    name: match.star.name,
                    az: match.star.az,
                    ze: match.star.ze,
                },
            };
            state.matches.push(addedMatch);
            trustedMatches.push(addedMatch);
            existingCatalogKeys.add(match.star.key);
            existingDetectionIds.add(match.detection.id);
            added += 1;
        }
        return added;
    }

    function recordAsterismEdgesFromResult(result, label = "asterism") {
        if (!result || !Array.isArray(result.matches) || result.matches.length < 3) {
            return 0;
        }
        const points = result.matches
            .filter(match => match && match.detection &&
                Number.isFinite(match.detection.x) && Number.isFinite(match.detection.y))
            .slice()
            .sort((a, b) => (a.star && b.star ? a.star.mag - b.star.mag : 0) ||
                Math.hypot(a.detection.x, a.detection.y) - Math.hypot(b.detection.x, b.detection.y))
            .slice(0, 40);
        const edgeKeys = new Set(state.asterismEdges.map(edge =>
            `${Math.round(edge.a.x * 10)},${Math.round(edge.a.y * 10)}:` +
            `${Math.round(edge.b.x * 10)},${Math.round(edge.b.y * 10)}`
        ));
        let added = 0;
        const diag = state.image ? Math.hypot(state.image.width, state.image.height) : Infinity;
        const maxEdge = Math.max(80, Math.min(0.28 * diag, 900));
        for (let i = 0; i < points.length; i += 1) {
            const a = points[i].detection;
            const neighbors = [];
            for (let j = 0; j < points.length; j += 1) {
                if (i === j) {
                    continue;
                }
                const b = points[j].detection;
                const distance = Math.hypot(a.x - b.x, a.y - b.y);
                if (distance <= maxEdge) {
                    neighbors.push({point: b, distance});
                }
            }
            neighbors.sort((m, n) => m.distance - n.distance);
            for (const neighbor of neighbors.slice(0, 2)) {
                const p = a.x < neighbor.point.x || (a.x === neighbor.point.x && a.y <= neighbor.point.y) ?
                    [a, neighbor.point] :
                    [neighbor.point, a];
                const key = `${Math.round(p[0].x * 10)},${Math.round(p[0].y * 10)}:` +
                    `${Math.round(p[1].x * 10)},${Math.round(p[1].y * 10)}`;
                if (edgeKeys.has(key)) {
                    continue;
                }
                edgeKeys.add(key);
                state.asterismEdges.push({
                    a: {x: p[0].x, y: p[0].y},
                    b: {x: p[1].x, y: p[1].y},
                    label,
                });
                added += 1;
            }
        }
        return added;
    }

    async function identifyStarsFromCurrentDetections(options = {}) {
        const label = options.label || "Automatic matching";
        const maxMag = Number.isFinite(options.maxMagnitude) ?
            options.maxMagnitude :
            Math.min(Number(controls.maxMag.value) || 4, 4);
        const minBlindMatches = Number.isFinite(options.minBlindMatches) ? options.minBlindMatches : 6;
        const minAsterismMatches = Number.isFinite(options.minAsterismMatches) ? options.minAsterismMatches : 4;
        const minProjectedMatches = Number.isFinite(options.minProjectedMatches) ? options.minProjectedMatches : 4;
        const existingCatalogKeys = options.reuseExistingMatchesForTransform === true ?
            null :
            new Set(state.matches.map(match => match.catalog.key));
        const existingDetectionIds = currentGenerationDetectionIdsFromMatches();
        const commonOptions = {
            imageWidth: state.image.width,
            imageHeight: state.image.height,
            maxMagnitude: maxMag,
            existingCatalogKeys,
            existingDetectionIds,
            deletedDetectionIds: state.deletedDetectionIds,
        };
        const diag = Math.hypot(state.image.width, state.image.height);
        const triangleDebug = snapshot => setTriangleDebugSnapshot({
            ...snapshot,
            stage: snapshot && snapshot.stage ? `${label}: ${snapshot.stage}` : label,
        });
        const cooperativeMatcherOptions = (startPercent, spanPercent, prefix) => ({
            onProgress: (percent, text) => {
                const p = Number.isFinite(percent) ? percent : 0;
                setLoadingProgress(
                    startPercent + spanPercent * Math.max(0, Math.min(100, p)) / 100,
                    `${label}: ${prefix}: ${text}`
                );
            },
            yieldFn: async () => {
                await yieldToBrowser();
            },
        });
        let result = {
            matches: [],
            status: "automatic matching: no matcher stage was enabled",
        };

        const radialAlphaProgressText = blindOptions => {
            const models = Array.isArray(blindOptions && blindOptions.preflattenModelCandidates) ?
                blindOptions.preflattenModelCandidates :
                ["pinhole", "fisheye"];
            if (!models.includes("fisheye")) {
                return "";
            }
            const candidates = Array.isArray(blindOptions && blindOptions.preflattenRadialAlphaCandidates) ?
                blindOptions.preflattenRadialAlphaCandidates :
                [0.30, 0.60, 0.90];
            return `; a_r grid ${candidates.map(value => Number(value).toFixed(2)).join(", ")}`;
        };

        if (options.includeBlind !== false) {
            const alphaText = radialAlphaProgressText(options.blindOptions || {});
            setLoadingProgress(
                Number.isFinite(options.progressBlind) ? options.progressBlind : 74,
                `${label}: matching bright spherical asterisms with the Yale catalog${alphaText}...`
            );
            await yieldToBrowser();
            const blindMatcher = typeof window.AidaAutoIdentifier.identifyStarsBlindAsync === "function" ?
                window.AidaAutoIdentifier.identifyStarsBlindAsync :
                window.AidaAutoIdentifier.identifyStarsBlind;
            result = await blindMatcher(
                visibleStarsForMatching(Math.max(
                    maxMag,
                    Number.isFinite(options.blindOptions && options.blindOptions.ambiguityMaxMagnitude) ?
                        options.blindOptions.ambiguityMaxMagnitude :
                        maxMag
                )),
                activeDetectedStars(),
                {
                    ...commonOptions,
                    maxDetections: 80,
                    maxCatalogStars: 80,
                    minMatches: minBlindMatches,
                    ...(options.blindOptions || {}),
                    triangleDebugStage: `${label} blind <= mag ${maxMag.toFixed(1)}`,
                    onTriangleDebug: triangleDebug,
                    ...cooperativeMatcherOptions(
                        Number.isFinite(options.progressBlind) ? options.progressBlind : 74,
                        7,
                        "blind asterism search"
                    ),
                }
            );
        }

        if (options.includeAsterisms !== false && result.matches.length < minBlindMatches) {
            setLoadingProgress(
                Number.isFinite(options.progressAsterism) ? options.progressAsterism : 82,
                `${label}: trying bright asterisms in the sky plane...`
            );
            await yieldToBrowser();
            const skyPlaneMatcher = typeof window.AidaAutoIdentifier.identifyStarsByAsterismsAsync === "function" ?
                window.AidaAutoIdentifier.identifyStarsByAsterismsAsync :
                window.AidaAutoIdentifier.identifyStarsByAsterisms;
            result = await skyPlaneMatcher(
                skyPlaneStarsForAsterismIdentification(maxMag),
                activeDetectedStars(),
                {
                    ...commonOptions,
                    maxDetections: 50,
                    maxCatalogStars: 90,
                    asterismMatchRadiusPx: Math.max(32, Math.min(70, 0.012 * diag)),
                    minMatches: minAsterismMatches,
                    ...(options.asterismOptions || {}),
                    triangleDebugStage: `${label} sky-plane <= mag ${maxMag.toFixed(1)}`,
                    onTriangleDebug: triangleDebug,
                    ...cooperativeMatcherOptions(
                        Number.isFinite(options.progressAsterism) ? options.progressAsterism : 82,
                        4,
                        "sky-plane asterism search"
                    ),
                }
            );
            const weakAsterismStages = Array.isArray(options.weakAsterismOptions) ?
                options.weakAsterismOptions :
                options.weakAsterismOptions ? [options.weakAsterismOptions] : [];
            for (const weakAsterismOptions of weakAsterismStages) {
                const weakMaxMag = Number(weakAsterismOptions && weakAsterismOptions.maxMagnitude);
                if (result.matches.length >= minAsterismMatches ||
                        !Number.isFinite(weakMaxMag) || weakMaxMag <= maxMag) {
                    continue;
                }
                setLoadingProgress(
                    Number.isFinite(weakAsterismOptions.progress) ? weakAsterismOptions.progress : 84,
                    `${label}: trying asterisms down to mag ${weakMaxMag.toFixed(1)}...`
                );
                await yieldToBrowser();
                result = await skyPlaneMatcher(
                    skyPlaneStarsForAsterismIdentification(weakMaxMag, {
                        minSeparationDeg: weakAsterismOptions.catalogMinSeparationDeg,
                    }),
                    activeDetectedStars(),
                    {
                        ...commonOptions,
                        maxMagnitude: weakMaxMag,
                        maxDetections: 80,
                        maxCatalogStars: 220,
                        asterismMatchRadiusPx: Math.max(36, Math.min(84, 0.015 * diag)),
                        minMatches: minAsterismMatches,
                        ...(options.asterismOptions || {}),
                        ...weakAsterismOptions,
                        triangleDebugStage: `${label} sky-plane <= mag ${weakMaxMag.toFixed(1)}`,
                        onTriangleDebug: triangleDebug,
                        ...cooperativeMatcherOptions(
                            Number.isFinite(weakAsterismOptions.progress) ? weakAsterismOptions.progress : 84,
                            4,
                            "deep asterism search"
                        ),
                    }
                );
            }
        }

        if (options.includeProjected !== false &&
                result.matches.length < Math.max(minAsterismMatches, minProjectedMatches)) {
            setLoadingProgress(
                Number.isFinite(options.progressProjected) ? options.progressProjected : 86,
                `${label}: matching with the current lens projection...`
            );
            await yieldToBrowser();
            const matchRadius = Math.max(22, Math.min(48, 0.018 * diag));
            result = window.AidaAutoIdentifier.identifyStars(
                projectedStarsForAutoIdentification(),
                activeDetectedStars(),
                {
                    ...commonOptions,
                    maxDetections: 50,
                    maxCatalogStars: 90,
                    maxDistancePx: matchRadius,
                    translationSearchRadiusPx: Math.max(80, Math.min(240, 0.10 * diag)),
                    minMatches: minProjectedMatches,
                    ...(options.projectedOptions || {}),
                }
            );
        }

        return result;
    }

    async function runAutoIdentifyPass(options = {}) {
        const label = options.label || "Automatic matching";
        const maxDetections = Number.isFinite(options.maxDetections) ? options.maxDetections : 50;
        const displayDetections = Math.max(
            maxDetections,
            Number.isFinite(options.displayDetections) ? options.displayDetections : Math.min(520, Math.max(160, maxDetections * 2))
        );
        setLoadingProgress(
            Number.isFinite(options.progressDetect) ? options.progressDetect : 8,
            `${label}: detecting star-like image peaks...`
        );
        await yieldToBrowser();
        await detectBrightImageStarsForAutoIdentify(displayDetections, options.detectorOptions || {});
        render();
        await yieldToBrowser();
        const result = await identifyStarsFromCurrentDetections(options);
        if (options.includeBlind !== false || options.includeAsterisms !== false) {
            recordAsterismEdgesFromResult(result, label);
        }
        setLoadingProgress(
            Number.isFinite(options.progressAdd) ? options.progressAdd : 94,
            `${label}: adding matched star pairings...`
        );
        await yieldToBrowser();
        const added = addAutoIdentificationMatches(result, options.methodLabel || "auto star finder", {
            maxAddDistancePx: options.maxAddDistancePx,
            maxAdditions: options.maxAdditions,
            maxMedianDistance: options.maxMedianDistance,
            minAsterismChecksForNewStars: options.minAsterismChecksForNewStars,
            maxAsterismCheckPartners: options.maxAsterismCheckPartners,
            newStarAsterismSignatureTolerance: options.newStarAsterismSignatureTolerance,
        });
        state.pendingMatch = null;
        clearDensityEstimate();
        state.showPickedMatchMarkers = true;
        state.lastFitVector = null;
        state.automaticMatchingStatus = `${String(result.status || "").replace(/auto-identify/g, "automatic matching")}; added ${added}`;
        updateAutoMatches();
        return {result, added, detections: activeDetectedStars().length};
    }

    function autoIdentifyCurrentMaxMagnitude() {
        const value = Number(controls.maxMag.value);
        return Number.isFinite(value) ? Math.max(0, Math.min(7, value)) : 6.0;
    }

    function autoIdentifyStageMagnitude(stageMaxMagnitude, currentMaxMagnitude) {
        return Math.min(stageMaxMagnitude, currentMaxMagnitude);
    }

    function weakAsterismFallbackOptions(options = {}) {
        const maxMagnitude = Number.isFinite(options.maxMagnitude) ? options.maxMagnitude : 6.5;
        return {
            summaryLabel: options.summaryLabel || "weak-star bootstrap fallback",
            maxMagnitude,
            maxDetections: options.maxDetections || 120,
            maxCatalogStars: options.maxCatalogStars || 260,
            maxCatalogTriangleStars: options.maxCatalogTriangleStars || 180,
            maxCatalogTriangles: options.maxCatalogTriangles || 25000,
            maxDetectionTriangleStars: options.maxDetectionTriangleStars || 90,
            maxDetectionTriangles: options.maxDetectionTriangles || 4500,
            maxCandidateTransforms: options.maxCandidateTransforms || 8000,
            maxNeighborTriangles: options.maxNeighborTriangles || 8,
            exhaustiveCatalogTriangles: options.exhaustiveCatalogTriangles === true,
            catalogMinSeparationDeg: options.catalogMinSeparationDeg,
            asterismMatchRadiusPx: options.asterismMatchRadiusPx,
            triangleSignatureRadius: options.triangleSignatureRadius || 0.02,
            minMatches: options.minMatches || 4,
        };
    }

    function deepAsterismFallbackStages(options = {}) {
        const prefix = options.summaryLabel || "weak-star";
        return [
            weakAsterismFallbackOptions({
                summaryLabel: `${prefix} asterism fallback`,
                maxMagnitude: 6.5,
                maxDetections: 140,
                maxCatalogStars: 320,
                maxCatalogTriangleStars: 220,
                maxCatalogTriangles: 36000,
                maxDetectionTriangleStars: 110,
                maxDetectionTriangles: 6500,
                maxCandidateTransforms: 10000,
                maxNeighborTriangles: 10,
                triangleSignatureRadius: 0.022,
            }),
            weakAsterismFallbackOptions({
                summaryLabel: `${prefix} deep asterism fallback`,
                maxMagnitude: 7.0,
                maxDetections: 220,
                maxCatalogStars: 10000,
                maxCatalogTriangleStars: 10000,
                maxCatalogTriangles: Number.MAX_SAFE_INTEGER,
                maxDetectionTriangleStars: 180,
                maxDetectionTriangles: 26000,
                maxCandidateTransforms: 32000,
                maxNeighborTriangles: 16,
                triangleSignatureRadius: 0.024,
                asterismMatchRadiusPx: options.deepRadiusPx,
                exhaustiveCatalogTriangles: true,
                catalogMinSeparationDeg: 3,
            }),
        ];
    }

    function drawImage() {
        if (!state.texture || !state.image) {
            return;
        }
        const vp = imageViewport();
        const x0 = (vp.x / canvas.width) * 2 - 1;
        const x1 = ((vp.x + vp.w) / canvas.width) * 2 - 1;
        const y0 = 1 - (vp.y / canvas.height) * 2;
        const y1 = 1 - ((vp.y + vp.h) / canvas.height) * 2;
        const texLeft = state.imageFlipX ? 1 : 0;
        const texRight = state.imageFlipX ? 0 : 1;
        const texTop = state.imageFlipY ? 1 : 0;
        const texBottom = state.imageFlipY ? 0 : 1;
        const vertices = new Float32Array([
            x0, y0, texLeft, texTop,
            x1, y0, texRight, texTop,
            x0, y1, texLeft, texBottom,
            x1, y1, texRight, texBottom,
        ]);
        gl.useProgram(imageProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(imageProgram, "a_pos");
        const aTex = gl.getAttribLocation(imageProgram, "a_tex");
        gl.enableVertexAttribArray(aPos);
        gl.enableVertexAttribArray(aTex);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
        gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, state.texture);
        gl.uniform1i(gl.getUniformLocation(imageProgram, "u_image"), 0);
        gl.uniform1f(gl.getUniformLocation(imageProgram, "u_brightness"), Number(controls.brightness.value) || 0);
        gl.uniform1f(gl.getUniformLocation(imageProgram, "u_contrast"), Number(controls.contrast.value) || 1);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function drawStars() {
        if (!state.image || state.projected.length === 0) {
            return;
        }
        const values = [];
        const margin = 20 * (window.devicePixelRatio || 1);
        const maxMag = Number(controls.maxMag.value) || 4;
        for (let i = 0; i < state.projected.length; i++) {
            const star = state.projected[i];
            if (star.mag > maxMag) {
                continue;
            }
            const [x, y] = canvasPixelFromImagePixel(star.x, star.y);
            if (Number.isFinite(x) && Number.isFinite(y) &&
                    x >= -margin && x <= canvas.width + margin &&
                    y >= -margin && y <= canvas.height + margin) {
                values.push(x, y, star.mag);
            }
        }
        if (values.length === 0) {
            return;
        }
        const data = new Float32Array(values);
        gl.useProgram(pointProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        const aPixel = gl.getAttribLocation(pointProgram, "a_pixel");
        const aMag = gl.getAttribLocation(pointProgram, "a_mag");
        gl.enableVertexAttribArray(aPixel);
        gl.enableVertexAttribArray(aMag);
        gl.vertexAttribPointer(aPixel, 2, gl.FLOAT, false, 12, 0);
        gl.vertexAttribPointer(aMag, 1, gl.FLOAT, false, 12, 8);
        gl.uniform2f(gl.getUniformLocation(pointProgram, "u_canvas_size"), canvas.width, canvas.height);
        gl.uniform1f(gl.getUniformLocation(pointProgram, "u_point_scale"),
            window.devicePixelRatio ? 1.15 * window.devicePixelRatio : 1.15);
        gl.uniform1f(gl.getUniformLocation(pointProgram, "u_max_mag"), maxMag);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.POINTS, 0, data.length / 3);
        gl.disable(gl.BLEND);
    }

    function visibleCatalogStars(maxMag = Number(controls.maxMag.value) || 4) {
        const margin = 20 * (window.devicePixelRatio || 1);
        return state.projected.filter(star => {
            if (star.mag > maxMag) {
                return false;
            }
            const [x, y] = canvasPixelFromImagePixel(star.x, star.y);
            return Number.isFinite(x) && Number.isFinite(y) &&
                x >= -margin && x <= canvas.width + margin &&
                y >= -margin && y <= canvas.height + margin;
        });
    }

    function projectRaDec(raHours, decDeg, date, lat, lon, optpar, optmod, clipToCanvas = true) {
        const azze = AidaTools.radecToAzZe(raHours, decDeg, date, lat, lon);
        if (!Number.isFinite(azze.az) || !Number.isFinite(azze.ze) || azze.ze > 88 * AidaTools.DEG) {
            return null;
        }
        const xy = AidaTools.cameraModel(azze.az, azze.ze, optpar, optmod, state.image.width, state.image.height);
        if (!Number.isFinite(xy.x) || !Number.isFinite(xy.y)) {
            return null;
        }
        const [x, y] = canvasPixelFromImagePixel(xy.x, xy.y);
        if (clipToCanvas && (x < -50 || x > canvas.width + 50 || y < -50 || y > canvas.height + 50)) {
            return null;
        }
        return [x, y];
    }

    function addGridPolyline(points, segments) {
        let previous = null;
        for (const point of points) {
            if (point && previous) {
                segments.push(previous[0], previous[1], point[0], point[1]);
            }
            previous = point;
        }
    }

    function projectAzEl(azDeg, elDeg, optpar, optmod, clipToCanvas = true) {
        const zeDeg = 90 - elDeg;
        const xy = AidaTools.cameraModel(
            azDeg * AidaTools.DEG,
            zeDeg * AidaTools.DEG,
            optpar,
            optmod,
            state.image.width,
            state.image.height
        );
        if (!Number.isFinite(xy.x) || !Number.isFinite(xy.y)) {
            return null;
        }
        const [x, y] = canvasPixelFromImagePixel(xy.x, xy.y);
        if (clipToCanvas && (x < -50 || x > canvas.width + 50 || y < -50 || y > canvas.height + 50)) {
            return null;
        }
        return [x, y];
    }

    function horizonPointForAz(azDeg, optpar, optmod) {
        const center = projectAzEl(0, 90, optpar, optmod, false) ||
            canvasPixelFromImagePixel(state.image.width / 2, state.image.height / 2);
        const horizon = projectAzEl(azDeg, 0, optpar, optmod, false);
        if (horizon) {
            return horizon;
        }
        const directionPoint = projectAzEl(azDeg, 30, optpar, optmod, false);
        if (!directionPoint) {
            return null;
        }
        const vx = directionPoint[0] - center[0];
        const vy = directionPoint[1] - center[1];
        const len = Math.hypot(vx, vy);
        if (len <= 1e-6) {
            return null;
        }
        return [center[0] + vx / len * Math.max(canvas.width, canvas.height),
            center[1] + vy / len * Math.max(canvas.width, canvas.height)];
    }

    function drawAzElGrid() {
        if (state.showKdePositionDots || !state.showAzElGrid || !state.image) {
            return;
        }
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value);
        const segments = [];

        for (let az = 0; az < 360; az += 15) {
            const points = [];
            for (let el = 0; el <= 90; el += 2) {
                points.push(projectAzEl(az, el, optpar, optmod));
            }
            addGridPolyline(points, segments);
        }

        for (const el of [0, 15, 30, 45, 60, 75]) {
            const points = [];
            for (let az = 0; az <= 360; az += 2) {
                points.push(projectAzEl(az === 360 ? 0 : az, el, optpar, optmod));
            }
            addGridPolyline(points, segments);
        }

        if (segments.length === 0) {
            return;
        }
        gl.useProgram(lineProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segments), gl.DYNAMIC_DRAW);
        const aPixel = gl.getAttribLocation(lineProgram, "a_pixel");
        gl.enableVertexAttribArray(aPixel);
        gl.vertexAttribPointer(aPixel, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(lineProgram, "u_canvas_size"), canvas.width, canvas.height);
        gl.uniform4f(gl.getUniformLocation(lineProgram, "u_color"), 1.0, 0.82, 0.2, 0.42);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.LINES, 0, segments.length / 2);
        gl.disable(gl.BLEND);
    }

    function drawRaDecGrid() {
        if (state.showKdePositionDots || !state.showRaDecGrid || !state.image) {
            return;
        }
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const lat = Number(controls.latDeg.value) || 0;
        const lon = Number(controls.lonDeg.value) || 0;
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value);
        const segments = [];

        for (let ra = 0; ra < 24; ra += 2) {
            const points = [];
            for (let dec = -80; dec <= 85; dec += 2.5) {
                points.push(projectRaDec(ra, dec, date, lat, lon, optpar, optmod));
            }
            addGridPolyline(points, segments);
        }

        for (const dec of [-60, -30, 0, 30, 60, 80]) {
            const points = [];
            for (let ra = 0; ra <= 24; ra += 0.25) {
                points.push(projectRaDec(ra === 24 ? 0 : ra, dec, date, lat, lon, optpar, optmod));
            }
            addGridPolyline(points, segments);
        }

        if (segments.length === 0) {
            return;
        }
        gl.useProgram(lineProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segments), gl.DYNAMIC_DRAW);
        const aPixel = gl.getAttribLocation(lineProgram, "a_pixel");
        gl.enableVertexAttribArray(aPixel);
        gl.vertexAttribPointer(aPixel, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(lineProgram, "u_canvas_size"), canvas.width, canvas.height);
        gl.uniform4f(gl.getUniformLocation(lineProgram, "u_color"), 0.3, 0.95, 1.0, 0.45);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.LINES, 0, segments.length / 2);
        gl.disable(gl.BLEND);
    }

    function drawAutoMatchResiduals() {
        if (!state.image || state.autoMatches.length === 0) {
            return;
        }
        const segments = [];
        for (const match of state.autoMatches) {
            const detected = imageMarkerCanvasPixel(match.detection.x, match.detection.y);
            const model = canvasPixelFromImagePixel(match.star.x, match.star.y);
            segments.push(detected[0], detected[1], model[0], model[1]);
        }
        gl.useProgram(lineProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segments), gl.DYNAMIC_DRAW);
        const aPixel = gl.getAttribLocation(lineProgram, "a_pixel");
        gl.enableVertexAttribArray(aPixel);
        gl.vertexAttribPointer(aPixel, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(lineProgram, "u_canvas_size"), canvas.width, canvas.height);
        gl.uniform4f(gl.getUniformLocation(lineProgram, "u_color"), 0.2, 1.0, 0.45, 0.55);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.LINES, 0, segments.length / 2);
        gl.disable(gl.BLEND);
    }

    function matchResidualRows() {
        const matches = fittingMatches();
        return residualRowsForMatches(matches);
    }

    function drawFitResiduals(rows = matchResidualRows()) {
        if (state.showKdePositionDots) {
            return;
        }
        if (rows.length === 0) {
            return;
        }
        const residualDisplayScale = 20;
        const triangles = [];
        const residualLineWidth = 3.0 * (window.devicePixelRatio || 1);
        const appendThickSegment = (x0, y0, x1, y1) => {
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.hypot(dx, dy);
            if (len < 1e-6) {
                return;
            }
            const nx = -dy / len * residualLineWidth * 0.5;
            const ny = dx / len * residualLineWidth * 0.5;
            triangles.push(
                x0 + nx, y0 + ny,
                x0 - nx, y0 - ny,
                x1 + nx, y1 + ny,
                x1 + nx, y1 + ny,
                x0 - nx, y0 - ny,
                x1 - nx, y1 - ny,
            );
        };
        for (const row of rows) {
            const detected = imageMarkerCanvasPixel(row.match.image.x, row.match.image.y);
            const trueModel = imageMarkerCanvasPixel(row.model.x, row.model.y);
            const model = [
                detected[0] + (trueModel[0] - detected[0]) * residualDisplayScale,
                detected[1] + (trueModel[1] - detected[1]) * residualDisplayScale,
            ];
            appendThickSegment(detected[0], detected[1], model[0], model[1]);
        }
        if (triangles.length === 0) {
            return;
        }
        gl.useProgram(lineProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(triangles), gl.DYNAMIC_DRAW);
        const aPixel = gl.getAttribLocation(lineProgram, "a_pixel");
        gl.enableVertexAttribArray(aPixel);
        gl.vertexAttribPointer(aPixel, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(lineProgram, "u_canvas_size"), canvas.width, canvas.height);
        gl.uniform4f(gl.getUniformLocation(lineProgram, "u_color"), 1.0, 0.0, 0.0, 0.9);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, triangles.length / 2);
        gl.disable(gl.BLEND);
        drawWorstResidualMarker(rows, residualDisplayScale);
    }

    function drawWorstResidualMarker(rows, residualDisplayScale = 1) {
        if (state.showKdePositionDots) {
            return;
        }
        if (rows.length === 0) {
            return;
        }
        const medianDx = median(rows.map(row => row.dx));
        const medianDy = median(rows.map(row => row.dy));
        let worst = null;
        for (const row of rows) {
            const modeDistance = Math.hypot(row.dx - medianDx, row.dy - medianDy);
            if (!worst || modeDistance > worst.modeDistance) {
                worst = {...row, modeDistance};
            }
        }
        if (!worst) {
            return;
        }
        const imagePoint = imageMarkerCanvasPixel(worst.match.image.x, worst.match.image.y);
        const trueModel = imageMarkerCanvasPixel(worst.model.x, worst.model.y);
        const displayPoint = [
            imagePoint[0] + (trueModel[0] - imagePoint[0]) * residualDisplayScale,
            imagePoint[1] + (trueModel[1] - imagePoint[1]) * residualDisplayScale,
        ];
        if (!addOverlayCircle(imagePoint, "worst-residual-marker")) {
            return;
        }
        const offset = 20 * (window.devicePixelRatio || 1);
        addOverlayLabel(`outlier ${worst.modeDistance.toFixed(1)} px from median residual`,
            [displayPoint[0] + offset, displayPoint[1] - offset],
            "worst-residual-label");
    }

    function svgEl(tag) {
        return document.createElementNS("http://www.w3.org/2000/svg", tag);
    }

    function updateResidualHistogram(rows) {
        residualHistogram.replaceChildren();
        residualHistogram.classList.toggle("visible", state.showFitResiduals);
        if (!state.showFitResiduals) {
            return;
        }

        const title = document.createElement("div");
        title.className = "residual-histogram-title";
        if (rows.length === 0) {
            title.textContent = "Fit residuals: no paired stars";
            residualHistogram.appendChild(title);
            return;
        }

        const rms = Math.sqrt(rows.reduce((acc, row) => acc + row.r * row.r, 0) / rows.length);
        const maxAbs = Math.max(1, ...rows.map(row => Math.max(Math.abs(row.dx), Math.abs(row.dy))));
        const span = Math.ceil(maxAbs * 1.15);
        title.textContent = `Fit residuals: ${rows.length} stars, RMS ${rms.toFixed(2)} px, axis +/-${span} px; image vectors 20x`;
        residualHistogram.appendChild(title);

        const svg = svgEl("svg");
        svg.setAttribute("viewBox", "0 0 240 180");
        svg.classList.add("residual-scatter-svg");
        const plot = {x0: 34, y0: 12, w: 184, h: 136};
        const sx = value => plot.x0 + (value + span) / (2 * span) * plot.w;
        const sy = value => plot.y0 + plot.h - (value + span) / (2 * span) * plot.h;
        const addLine = (x1, y1, x2, y2, className) => {
            const line = svgEl("line");
            line.setAttribute("x1", x1.toFixed(2));
            line.setAttribute("y1", y1.toFixed(2));
            line.setAttribute("x2", x2.toFixed(2));
            line.setAttribute("y2", y2.toFixed(2));
            line.classList.add(className);
            svg.appendChild(line);
        };
        addLine(plot.x0, sy(-span), plot.x0 + plot.w, sy(-span), "residual-scatter-grid");
        addLine(plot.x0, sy(span), plot.x0 + plot.w, sy(span), "residual-scatter-grid");
        addLine(sx(-span), plot.y0, sx(-span), plot.y0 + plot.h, "residual-scatter-grid");
        addLine(sx(span), plot.y0, sx(span), plot.y0 + plot.h, "residual-scatter-grid");
        addLine(plot.x0, sy(0), plot.x0 + plot.w, sy(0), "residual-scatter-axis");
        addLine(sx(0), plot.y0, sx(0), plot.y0 + plot.h, "residual-scatter-axis");

        for (const row of rows) {
            const point = svgEl("circle");
            point.setAttribute("cx", sx(row.dx).toFixed(2));
            point.setAttribute("cy", sy(row.dy).toFixed(2));
            point.setAttribute("r", "3.4");
            point.classList.add("residual-scatter-point");
            svg.appendChild(point);
        }

        const labels = [
            [`x residual (px)`, plot.x0 + plot.w / 2, 174, "middle"],
            [`y residual (px)`, 10, plot.y0 + plot.h / 2, "middle", -90],
            [`-${span}`, plot.x0, 164, "middle"],
            [`+${span}`, plot.x0 + plot.w, 164, "middle"],
            [`+${span}`, 22, plot.y0 + 3, "end"],
            [`-${span}`, 22, plot.y0 + plot.h + 3, "end"],
        ];
        for (const [text, x, y, anchor, rotate] of labels) {
            const label = svgEl("text");
            label.textContent = text;
            label.setAttribute("x", x.toFixed(2));
            label.setAttribute("y", y.toFixed(2));
            label.setAttribute("text-anchor", anchor);
            if (rotate) {
                label.setAttribute("transform", `rotate(${rotate} ${x.toFixed(2)} ${y.toFixed(2)})`);
            }
            label.classList.add("residual-scatter-label");
            svg.appendChild(label);
        }
        residualHistogram.appendChild(svg);
    }

    function setTriangleDebugSnapshot(snapshot) {
        state.triangleDebugSnapshot = snapshot ? {
            ...snapshot,
            catalog: snapshot.catalog || {count: 0, points: []},
            image: snapshot.image || {count: 0, points: []},
        } : null;
        updateTriangleDebugPlot();
    }

    function updateTriangleDebugPlot() {
        if (!triangleDebugPlot) {
            return;
        }
        triangleDebugPlot.replaceChildren();
        const snapshot = state.triangleDebugSnapshot;
        const hasSnapshot = Boolean(snapshot);
        triangleDebugPlot.classList.toggle("visible", hasSnapshot);
        triangleDebugPlot.setAttribute("aria-hidden", hasSnapshot ? "false" : "true");
        if (!hasSnapshot) {
            return;
        }

        const title = document.createElement("div");
        title.className = "triangle-debug-title";
        const pieces = [
            snapshot.stage || "triangle search",
            `cat ${snapshot.catalog.count}`,
            `img ${snapshot.image.count}`,
        ];
        if (Number.isFinite(snapshot.maxMagnitude)) {
            pieces.push(`mag <= ${snapshot.maxMagnitude.toFixed(1)}`);
        }
        if (snapshot.preflattenModel && snapshot.preflattenModel !== "catalog") {
            if (snapshot.preflattenModel === "pinhole") {
                pieces.push(`flat f1 ${Number(snapshot.f1).toFixed(2)}`);
            } else {
                pieces.push(`${snapshot.preflattenModel} f1 ${Number(snapshot.f1).toFixed(2)} a ${Number(snapshot.radialAlpha).toFixed(2)}`);
            }
        }
        if (snapshot.quality) {
            pieces.push(
                `overlap ${(100 * snapshot.quality.occupiedOverlap).toFixed(0)}%`,
                `shape ${(100 * snapshot.quality.bhattacharyya).toFixed(0)}%`
            );
        }
        if (snapshot.supportTriangles) {
            const acceptedSupport = snapshot.supportTriangles.acceptedCount || 0;
            const rejectedSupport = snapshot.supportTriangles.rejectedCount || 0;
            pieces.push(`support ${acceptedSupport}/${acceptedSupport + rejectedSupport}`);
        }
        if (Number.isFinite(snapshot.regionalAsterismCandidateCount) &&
                Number.isFinite(snapshot.totalAsterismCandidateCount)) {
            pieces.push(`regional ${snapshot.regionalAsterismCandidateCount}/${snapshot.totalAsterismCandidateCount}`);
        }
        title.textContent = pieces.join("; ");
        triangleDebugPlot.appendChild(title);
    }

    function clearTransientDebugOverlays() {
        state.asterismEdges = [];
        state.triangleDebugSnapshot = null;
        state.showFitResiduals = false;
        state.pendingMatch = null;
        state.centroidPreview = null;
        state.notStarTilePreview = null;
        state.junkStarFinderPreview = null;
        state.notStarTilePaintActive = false;
        state.junkStarFinderPaintActive = false;
        state.lastNotStarTilePaintPoint = null;
        state.lastJunkStarFinderPoint = null;
        updateFitResidualButton();
        updateTriangleDebugPlot();
    }

    function nearestCardinalAzimuthDistance(azDeg) {
        const normalized = ((azDeg % 360) + 360) % 360;
        let best = 180;
        for (let cardinal = 0; cardinal < 360; cardinal += 45) {
            const diff = Math.abs(((normalized - cardinal + 540) % 360) - 180);
            best = Math.min(best, diff);
        }
        return best;
    }

    function drawAzElGridLabels(optpar, optmod) {
        if (!state.showAzElGrid) {
            return;
        }
        for (let az = 0; az < 360; az += 30) {
            if (nearestCardinalAzimuthDistance(az) < 1e-6) {
                continue;
            }
            const point = horizonPointForAz(az, optpar, optmod);
            if (point) {
                addOverlayLabel(`${az}° az`, point, "grid-label azel-label", true);
            }
        }

        for (const el of [15, 30, 45, 60, 75]) {
            const point = projectAzEl(90, el, optpar, optmod, false);
            if (point) {
                addOverlayLabel(`${el}° el`, point, "grid-label azel-label", true);
            }
        }
    }

    function drawRaDecGridLabels(optpar, optmod) {
        if (!state.showRaDecGrid) {
            return;
        }
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const lat = Number(controls.latDeg.value) || 0;
        const lon = Number(controls.lonDeg.value) || 0;

        for (let ra = 0; ra < 24; ra += 4) {
            const point = projectRaDec(ra, 0, date, lat, lon, optpar, optmod, false);
            if (point) {
                addOverlayLabel(`${ra}h`, point, "grid-label radec-label", true);
            }
        }

        for (const dec of [-60, -30, 0, 30, 60, 80]) {
            const point = projectRaDec(0, dec, date, lat, lon, optpar, optmod, false);
            if (point) {
                const sign = dec > 0 ? "+" : "";
                addOverlayLabel(`${sign}${dec}° dec`, point, "grid-label radec-label", true);
            }
        }
    }

    function drawStarNameLabels() {
        if (!state.showStarNames) {
            return;
        }
        const offset = 12 * (window.devicePixelRatio || 1);
        for (const star of visibleCatalogStars()) {
            const [x, y] = canvasPixelFromImagePixel(star.x, star.y);
            const label = star.name && star.name.trim()
                ? star.name.trim()
                : `mag ${star.mag.toFixed(1)}`;
            addOverlayLabel(label, [x + offset, y - offset], "star-name-label");
        }
    }

    function starMagnitudeClass(mag) {
        if (mag <= 2) {
            return "mag-radius-6";
        }
        if (mag <= 4) {
            return "mag-radius-4";
        }
        return "mag-radius-2";
    }

    function drawCatalogPairingMarkers() {
        const offset = 12 * (window.devicePixelRatio || 1);
        for (const star of visibleCatalogStars()) {
            if (isMatchedCatalogStar(star)) {
                continue;
            }
            const [x, y] = canvasPixelFromImagePixel(star.x, star.y);
            addOverlayCircle([x, y], `catalog-pairing-marker ${starMagnitudeClass(star.mag)}`);
            if (state.showStarNames) {
                const label = star.name && star.name.trim()
                    ? star.name.trim()
                    : `mag ${star.mag.toFixed(1)}`;
                addOverlayLabel(label, [x + offset, y - offset], "catalog-pairing-label");
            }
        }
    }

    function drawMatchMarkers(optpar, optmod) {
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const lat = Number(controls.latDeg.value) || 0;
        const lon = Number(controls.lonDeg.value) || 0;
        const labelOffset = 16 * (window.devicePixelRatio || 1);
        for (const match of state.matches) {
            const matchLabel = match.catalog.name && match.catalog.name.trim()
                ? match.catalog.name.trim()
                : `mag ${match.catalog.mag.toFixed(1)}`;
            const markerClass = `paired-marker ${starMagnitudeClass(match.catalog.mag)}`;
            if (state.showPickedMatchMarkers) {
                const imagePoint = imageMarkerCanvasPixel(match.image.x, match.image.y);
                const visible = addOverlayCircle(imagePoint, markerClass);
                if (visible && state.showStarNames) {
                    addOverlayLabel(matchLabel, [imagePoint[0] + labelOffset, imagePoint[1] - labelOffset],
                        "match-label");
                }
            }

            const catalogPoint = projectRaDec(
                match.catalog.raHours,
                match.catalog.decDeg,
                date,
                lat,
                lon,
                optpar,
                optmod,
                false
            );
            if (catalogPoint && addOverlayCircle(catalogPoint, markerClass)) {
                if (state.showStarNames) {
                    addOverlayLabel(matchLabel, [catalogPoint[0] + labelOffset, catalogPoint[1] - labelOffset],
                        "match-label");
                }
            }
        }

        if (state.pendingMatch) {
            addOverlayCircle(imageMarkerCanvasPixel(state.pendingMatch.image.x, state.pendingMatch.image.y),
                "paired-marker mag-radius-6 match-pending");
        }
        if (state.centroidPreview && Date.now() < state.centroidPreview.expiresAt) {
            const point = imageMarkerCanvasPixel(state.centroidPreview.x, state.centroidPreview.y);
            addOverlayCircle(point, "centroid-preview-marker");
        }

    }

    function drawKdePositionDots() {
        for (const match of state.matches) {
            addOverlayCircle(imageMarkerCanvasPixel(match.image.x, match.image.y), "kde-position-dot");
        }
    }

    function drawAutoDetectionMarkers() {
        if (!state.image || !state.showAutoDetectionMarkers ||
                !(state.displayMode === "pairing" || state.displayMode === "pureImage")) {
            return;
        }
        for (const detection of activeDetectedStars()) {
            addOverlayCircle(imageMarkerCanvasPixel(detection.x, detection.y), "detected-marker");
        }
    }

    function drawBadStarFinderMarkers() {
        if (!state.image || !(state.displayMode === "pairing" || state.displayMode === "pureImage")) {
            return;
        }
        for (const tile of state.notStarTiles) {
            addOverlayRawRect(
                tile.x0,
                tile.y0,
                tile.width,
                tile.height,
                "not-star-tile-black"
            );
        }
        if (state.notStarTilePreview) {
            addOverlayRawRect(
                state.notStarTilePreview.x0,
                state.notStarTilePreview.y0,
                state.notStarTilePreview.width,
                state.notStarTilePreview.height,
                "not-star-tile-preview"
            );
        }
        for (const region of state.junkStarFinderRegions) {
            addOverlayRadiusCircle(region.x, region.y, region.radius, "junk-star-finder-region");
        }
        if (state.junkStarFinderPreview) {
            addOverlayRadiusCircle(
                state.junkStarFinderPreview.x,
                state.junkStarFinderPreview.y,
                state.junkStarFinderPreview.radius,
                "junk-star-finder-preview"
            );
        }
        for (const detection of state.badStarFinderDetections) {
            addOverlayCircle(imageMarkerCanvasPixel(detection.x, detection.y), "bad-detected-marker");
        }
    }

    function drawAsterismLines() {
        if (!state.showAsterismLines) {
            return;
        }
        const supportEdges = state.triangleDebugSnapshot &&
            state.triangleDebugSnapshot.supportTriangles &&
            Array.isArray(state.triangleDebugSnapshot.supportTriangles.acceptedEdges) ?
            state.triangleDebugSnapshot.supportTriangles.acceptedEdges : [];
        if (supportEdges.length) {
            addOverlaySvgLineLayer(supportEdges, "support-asterism-lines");
        }
        if (state.asterismEdges.length) {
            addOverlaySvgLineLayer(state.asterismEdges, "lucky-asterism-lines");
        }
    }

    function drawOverlayLabels() {
        cardinalLayer.replaceChildren();
        if (!state.image) {
            return;
        }
        if (state.showKdePositionDots) {
            drawKdePositionDots();
            return;
        }
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value);
        const directions = [
            ["N", 0], ["NE", 45], ["E", 90], ["SE", 135],
            ["S", 180], ["SW", 225], ["W", 270], ["NW", 315],
        ];

        for (const [label, azDeg] of directions) {
            const backingPixel = horizonPointForAz(azDeg, optpar, optmod);
            if (backingPixel) {
                addOverlayLabel(label, backingPixel, "", true);
            }
        }

        drawAzElGridLabels(optpar, optmod);
        drawRaDecGridLabels(optpar, optmod);
        if (state.displayMode === "pairing") {
            drawAsterismLines();
            drawAutoDetectionMarkers();
            drawBadStarFinderMarkers();
            drawCatalogPairingMarkers();
            drawMatchMarkers(optpar, optmod);
        } else if (state.displayMode === "pureImage") {
            drawAutoDetectionMarkers();
            drawBadStarFinderMarkers();
        } else {
            drawStarNameLabels();
        }
    }

    function render() {
        resizeCanvas();
        canvas.classList.toggle("match-mode", state.starMatchMode);
        canvas.classList.toggle("probe-mode", false);
        canvas.classList.toggle("delete-mode", state.deleteDetectionMode);
        canvas.classList.toggle("mask-mode", state.maskMode);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (state.showFitResiduals || state.displayMode === "pairing" || state.displayMode === "pureImage") {
            drawImage();
        }
        if (state.showFitResiduals) {
            const rows = matchResidualRows();
            cardinalLayer.replaceChildren();
            if (state.showKdePositionDots) {
                drawKdePositionDots();
            } else {
                drawFitResiduals(rows);
            }
            updateResidualHistogram(rows);
        } else {
            updateResidualHistogram([]);
            if (state.displayMode === "pureImage") {
                cardinalLayer.replaceChildren();
            } else if (state.displayMode === "pureStellarium") {
                drawStars();
                cardinalLayer.replaceChildren();
            } else {
                drawAzElGrid();
                drawRaDecGrid();
                if (state.displayMode === "stellarium") {
                    drawStars();
                }
                drawOverlayLabels();
            }
        }
        updateTriangleDebugPlot();
        controls.brightnessValue.textContent = Number(controls.brightness.value).toFixed(2);
        controls.contrastValue.textContent = Number(controls.contrast.value).toFixed(2);
        controls.highPassWidthValue.textContent = Number(controls.highPassWidth.value).toFixed(0);
        controls.magValue.textContent = Number(controls.maxMag.value).toFixed(1);
        matchInstructions.textContent = matchInstructionText();
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const optpar = currentOptpar();
        const optmod = Number(controls.optmod.value) || 2;
        const optparWithModel = [optmod, ...optpar].map(value =>
            Number.isFinite(value) ? value.toPrecision(12) : String(value)
        ).join(", ");
        const currentFit = currentFitVector();
        const lastFitDiff = fitVectorMaxAbsDiff(currentFit, state.lastAcceptedFitVector);
        const fitStaleText = Number.isFinite(lastFitDiff) && lastFitDiff > 1e-8 ?
            `last accepted fit: stale, current optpar differs by up to ${lastFitDiff.toExponential(2)}\n` :
            Number.isFinite(lastFitDiff) ?
                "last accepted fit: current\n" :
                "last accepted fit: none\n";
        updateLensEquation(optpar, optmod);
        drawRotationVisualization();
        statusEl.textContent =
            `AIDA calibrator version: ${APP_VERSION}\n` +
            `image: ${state.imageName || "none"}\n` +
            `timestamp: ${date.toISOString()}\n` +
            `site: lat ${controls.latDeg.value} deg, lon ${controls.lonDeg.value} deg, alt ${controls.altM.value} m\n` +
            `optpar: [${optparWithModel}]\n` +
            `image high-pass: ${controls.highPassImage.checked ? `${controls.highPassWidth.value} px Gaussian` : "off"}\n` +
            `catalog stars <= mag ${controls.maxMag.value}: ` +
            `${state.projected.filter(star => star.mag <= Number(controls.maxMag.value)).length}\n` +
            `f1/f2: ${optpar[0].toFixed(6)}, ${optpar[1].toFixed(6)}\n` +
            `boresight az/el: ${boresightAzElFromCameraAngles(optpar[2], optpar[3]).az.toFixed(2)}, ` +
            `${boresightAzElFromCameraAngles(optpar[2], optpar[3]).el.toFixed(2)} deg\n` +
            `du/dv: ${optpar[5].toPrecision(12)}, ${optpar[6].toPrecision(12)}\n` +
            `mouse drag: edits lens parameters directly\n` +
            `overlay flip x/y: ${state.flipX}/${state.flipY}\n` +
            `image flip x/y: ${state.imageFlipX}/${state.imageFlipY}\n` +
            `image masks: ${state.maskRegions.length}\n` +
            `bad star finder detections: ${state.badStarFinderDetections.length} in ${state.junkStarFinderRegions.length} marked regions\n` +
            `RA/Dec grid: ${state.showRaDecGrid ? "on" : "off"}\n` +
            `az/el grid: ${state.showAzElGrid ? "on" : "off"}\n` +
            `display mode: ${state.displayMode}\n` +
            `star names: ${state.showStarNames ? "on" : "off"}\n` +
            `KDE sub-pixel dots: ${state.showKdePositionDots ? "on" : "off"}\n` +
            `asterism lines: ${state.showAsterismLines ? "on" : "off"} (${state.asterismEdges.length} edges)\n` +
            `fit residuals: ${state.showFitResiduals ? "on" : "off"}\n` +
            `star pairing armed: ${state.starMatchMode ? "on" : "off"}${state.pendingMatch ? " (select catalog star)" : ""}\n` +
            `matched star pairs: ${state.matches.length}\n` +
            fitStaleText +
            `${state.automaticMatchingStatus}\n` +
            `${autoDetectionStatusText()}\n` +
            `${fitResidualStatusText()}\n` +
            state.fitMessage;
    }

    function recomputeAndRender() {
        updateProjection();
        render();
    }

    function setDisplayMode(mode) {
        if (!["pairing", "stellarium", "pureImage", "pureStellarium"].includes(mode)) {
            return;
        }
        if (Object.prototype.hasOwnProperty.call(state.maxMagByMode, state.displayMode)) {
            state.maxMagByMode[state.displayMode] = Number(controls.maxMag.value) || 4.0;
            state.starNamesByMode[state.displayMode] = state.showStarNames;
        }
        state.displayMode = mode;
        if (Object.prototype.hasOwnProperty.call(state.maxMagByMode, mode)) {
            controls.maxMag.value = state.maxMagByMode[mode].toFixed(1);
            state.showStarNames = state.starNamesByMode[mode];
        }
        updateStarNameButton();
    }

    function matchInstructionText() {
        if (!state.image) {
            return "Load an image first. Press s for star picking, or c to switch between pairing and Stellarium views.";
        }
        if (state.showFitResiduals) {
            return "Fit residual mode: normal markings are hidden. Red lines connect each identified image star to its fitted catalog position; press r to return.";
        }
        if (state.displayMode === "pureImage") {
            return "Pure image view: labels and pairing annotations are hidden. Press x for pure Stellarium view, or s to start picking stars.";
        }
        if (state.displayMode === "pureStellarium") {
            return "Pure Stellarium view: labels and pairing annotations are hidden. Press x for pure image view, or s to start picking stars.";
        }
        if (state.deleteDetectionMode) {
            return "Pairing delete mode: click a matched image or catalog star to remove that star pairing.";
        }
        if (state.maskMode) {
            return "Bad star finder marking: hold M and click or drag over yellow detections. A 100 px radius circle records their pixel positions for training and hides them from Lucky matching.";
        }
        if (state.zoomMode) {
            return "Zoom mode: move the mouse over the image to inspect a 100 x 100 raw-pixel region.";
        }
        if (!state.starMatchMode) {
            if (state.showKdePositionDots) {
                return "KDE dot inspection: all other markings are hidden. Press k to return to the normal overlay.";
            }
            return "Star pairing view: left-drag moves the 90 deg elevation point in x/y. Right-drag rotates the azimuth grid around that point. Wheel edits f1/f2 together. Press c for Stellarium view, x for pure image/Stellarium views, s to pick an image star, h to show/hide detected stars, k for KDE sub-pixel dots, n to show/hide star names, d to delete a star pairing, hold m to mark bad yellow detections, or z to zoom.";
        }
        if (!state.pendingMatch) {
            return "Star pairing: hold s and click the image star. A KDE centroid fit will select the sub-pixel star position.";
        }
        return "Image star selected. Release s, then click the matching red catalog star below the current magnitude limit.";
    }

    function autoDetectionStatusText() {
        if (!state.image) {
            return "auto detections: no image";
        }
        const active = activeDetectedStars().length;
        return `auto detections: ${active}/${state.detectedStars.length} active, ` +
            `${state.badStarFinderDetections.length} marked bad, ` +
            `${state.showAutoDetectionMarkers ? "shown" : "hidden"} with H; ${state.detectorStatus}`;
    }

    function fitResidualStatusText() {
        const rows = matchResidualRows();
        if (rows.length === 0) {
            return "fit residual scatter: no identified stars";
        }
        let sumDx = 0;
        let sumDy = 0;
        let sumR2 = 0;
        for (const row of rows) {
            sumDx += row.dx;
            sumDy += row.dy;
            sumR2 += row.r * row.r;
        }
        const meanDx = sumDx / rows.length;
        const meanDy = sumDy / rows.length;
        let varDx = 0;
        let varDy = 0;
        for (const row of rows) {
            varDx += (row.dx - meanDx) * (row.dx - meanDx);
            varDy += (row.dy - meanDy) * (row.dy - meanDy);
        }
        const sigmaDx = Math.sqrt(varDx / rows.length);
        const sigmaDy = Math.sqrt(varDy / rows.length);
        const rms = Math.sqrt(sumR2 / rows.length);
        const sortedR = rows.map(row => row.r).sort((a, b) => a - b);
        const medianR = sortedR[Math.floor(sortedR.length / 2)];
        const maxR = sortedR[sortedR.length - 1];
        const medianDx = median(rows.map(row => row.dx));
        const medianDy = median(rows.map(row => row.dy));
        return `fit residual scatter: ${rows.length} stars, RMS ${rms.toFixed(2)} px, ` +
            `median ${medianR.toFixed(2)} px, max ${maxR.toFixed(2)} px, ` +
            `median dx/dy ${medianDx.toFixed(2)}/${medianDy.toFixed(2)} px, ` +
            `mean dx/dy ${meanDx.toFixed(2)}/${meanDy.toFixed(2)} px, ` +
            `sigma dx/dy ${sigmaDx.toFixed(2)}/${sigmaDy.toFixed(2)} px`;
    }

    function wrapDegrees180(value) {
        let wrapped = ((value + 180) % 360 + 360) % 360 - 180;
        if (wrapped === -180) {
            wrapped = 180;
        }
        return wrapped;
    }

    function imageGray(x, y) {
        if (!state.imagePixels) {
            return 0;
        }
        const ix = Math.max(0, Math.min(state.image.width - 1, Math.round(x)));
        const iy = Math.max(0, Math.min(state.image.height - 1, Math.round(y)));
        if (isMaskedImagePixel(ix, iy)) {
            return 0;
        }
        const k = 4 * (iy * state.image.width + ix);
        const data = state.imagePixels.data;
        return 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
    }

    function imageGrayInterpolated(x, y) {
        if (!state.imagePixels) {
            return 0;
        }
        const gx = Math.max(0, Math.min(state.image.width - 1, x));
        const gy = Math.max(0, Math.min(state.image.height - 1, y));
        if (isMaskedImagePixel(Math.round(gx), Math.round(gy))) {
            return 0;
        }
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const x1 = Math.min(state.image.width - 1, x0 + 1);
        const y1 = Math.min(state.image.height - 1, y0 + 1);
        const tx = gx - x0;
        const ty = gy - y0;
        const v00 = imageGrayAtIndex(x0, y0);
        const v10 = imageGrayAtIndex(x1, y0);
        const v01 = imageGrayAtIndex(x0, y1);
        const v11 = imageGrayAtIndex(x1, y1);
        const top = v00 * (1 - tx) + v10 * tx;
        const bottom = v01 * (1 - tx) + v11 * tx;
        return top * (1 - ty) + bottom * ty;
    }

    function imageGrayAtIndex(ix, iy) {
        if (isMaskedImagePixel(ix, iy)) {
            return 0;
        }
        const k = 4 * (iy * state.image.width + ix);
        const data = state.imagePixels.data;
        return 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
    }

    function median(values) {
        if (values.length === 0) {
            return 0;
        }
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
    }

    function percentile(sortedValues, fraction) {
        if (sortedValues.length === 0) {
            return 0;
        }
        const idx = Math.max(0, Math.min(sortedValues.length - 1,
            Math.round(fraction * (sortedValues.length - 1))));
        return sortedValues[idx];
    }

    function autoAdjustDisplayStretch() {
        if (!state.imagePixels || !state.image) {
            controls.brightness.value = "0.06";
            controls.contrast.value = "1.00";
            return;
        }
        const values = [];
        state.displayPixels = null;
        state.highPassCacheKey = "";
        const stretchPixels = displayImagePixels() || state.imagePixels;
        const data = stretchPixels.data;
        const width = state.image.width;
        const height = state.image.height;
        const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 90000)));
        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                const k = 4 * (y * width + x);
                values.push(0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]);
            }
        }
        values.sort((a, b) => a - b);
        const lo = percentile(values, 0.08);
        const hi = percentile(values, 0.997);
        const span = Math.max(8, hi - lo);
        const contrast = Math.max(0.25, Math.min(4.0, 0.9 * 255 / span));
        const mid = 0.5 * (lo + hi) / 255;
        const brightness = Math.max(-1.0, Math.min(1.0, -(mid - 0.5) * contrast + 0.06));
        controls.contrast.value = contrast.toFixed(2);
        controls.brightness.value = brightness.toFixed(2);
    }

    function setLoadingProgress(percent, text) {
        loadingOverlay.classList.add("visible");
        loadingBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        loadingText.textContent = text;
    }

    function hideLoadingProgress() {
        loadingBar.style.width = "100%";
        window.setTimeout(() => {
            loadingOverlay.classList.remove("visible");
        }, 180);
    }

    function yieldToBrowser() {
        return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
    }

    function detectorStarRadius() {
        return 5;
    }

    function detectorCacheKey(starRadius) {
        const maskKey = state.maskRegions
            .map(region => `${region.x},${region.y},${region.radius}`)
            .join(";");
        const junkKey = state.junkStarFinderRegions
            .map(region => `${region.x},${region.y},${region.radius}`)
            .join(";");
        return `${state.imageName}:${state.image.width}x${state.image.height}:r${starRadius}:m${maskKey}:j${junkKey}`;
    }

    function buildDetectorCandidateCache(starRadius) {
        const width = state.image.width;
        const height = state.image.height;
        const samples = [];
        for (let y = 4; y < height; y += 8) {
            for (let x = 4; x < width; x += 8) {
                if (!isMaskedImagePixel(x, y) && !isJunkStarFinderPixel(x, y)) {
                    samples.push(imageGrayAtIndex(x, y));
                }
            }
        }
        if (samples.length === 0) {
            return {
                key: detectorCacheKey(starRadius),
                starRadius,
                bg: 0,
                sigma: 1,
                candidates: [],
                rawCandidateCount: 0,
                status: "detector: image fully masked",
            };
        }
        const bg = median(samples);
        const absDev = samples.map(value => Math.abs(value - bg));
        const sigma = Math.max(1, 1.4826 * median(absDev));
        const minThresholdSigma = 1.0;
        const centroidRadius = starRadius;
        const wideCentroidRadius = Math.max(centroidRadius + 1, Math.round(1.6 * starRadius));
        const annulusInner = Math.max(4, 1.3 * starRadius);
        const annulusOuter = Math.max(annulusInner + 2, 2.2 * starRadius);
        const maxRadius2 = Math.max(28.0, Math.pow(1.45 * starRadius, 2));
        const preThreshold = bg + Math.max(2, 0.35 * minThresholdSigma * sigma);
        const candidates = [];
        let rawCandidateCount = 0;

        for (let y = 2; y < height - 2; y++) {
            for (let x = 2; x < width - 2; x++) {
                if (isMaskedImagePixel(x, y, annulusOuter + 2) ||
                        isJunkStarFinderPixel(x, y, annulusOuter + 2)) {
                    continue;
                }
                const value = imageGrayAtIndex(x, y);
                if (value < preThreshold) {
                    continue;
                }
                let isPeak = true;
                for (let dy = -1; dy <= 1 && isPeak; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if ((dx !== 0 || dy !== 0) && imageGrayAtIndex(x + dx, y + dy) > value) {
                            isPeak = false;
                            break;
                        }
                    }
                }
                if (!isPeak) {
                    continue;
                }

                const bgSamples = [];
                const bgRadius = Math.ceil(annulusOuter);
                for (let dy = -bgRadius; dy <= bgRadius; dy++) {
                    for (let dx = -bgRadius; dx <= bgRadius; dx++) {
                        const r = Math.hypot(dx, dy);
                        if (r >= annulusInner && r <= annulusOuter &&
                                x + dx >= 0 && x + dx < width &&
                                y + dy >= 0 && y + dy < height) {
                            bgSamples.push(imageGrayAtIndex(x + dx, y + dy));
                        }
                    }
                }
                const localBg = bgSamples.length ? median(bgSamples) : bg;
                const localDev = bgSamples.map(sample => Math.abs(sample - localBg));
                const localSigma = Math.max(1, 1.4826 * median(localDev));
                const peakContrast = value - localBg;
                const localContrastThreshold = Math.max(
                    minThresholdSigma * localSigma,
                    3 + 2 * minThresholdSigma
                );
                if (peakContrast < localContrastThreshold) {
                    continue;
                }
                rawCandidateCount += 1;
                let centroid = weightedCentroid(x, y, centroidRadius, localBg);
                if (!Number.isFinite(centroid.x) || !Number.isFinite(centroid.y)) {
                    continue;
                }
                let peak = imageGray(centroid.x, centroid.y);
                let flux = 0;
                let moment = 0;
                let mxx = 0;
                let myy = 0;
                let mxy = 0;
                let saturated = 0;
                let coreFlux = 0;
                let outerFlux = 0;
                let shoulderFlux = 0;
                let shoulderCount = 0;
                let radius2 = Infinity;
                let elongation = Infinity;
                let coreFluxFraction = 0;
                let outerFluxFraction = 0;
                let peakDominance = 0;
                for (const apertureRadius of [centroidRadius, wideCentroidRadius]) {
                    flux = 0;
                    moment = 0;
                    mxx = 0;
                    myy = 0;
                    mxy = 0;
                    saturated = 0;
                    coreFlux = 0;
                    outerFlux = 0;
                    shoulderFlux = 0;
                    shoulderCount = 0;
                    const coreRadius2 = Math.pow(Math.max(1.1, Math.min(1.8, apertureRadius * 0.38)), 2);
                    const outerRadius2 = Math.pow(Math.max(1.8, apertureRadius * 0.62), 2);
                    const shoulderInner2 = Math.pow(1.4, 2);
                    const shoulderOuter2 = Math.pow(Math.min(apertureRadius, 3.4), 2);
                    for (let dy = -apertureRadius; dy <= apertureRadius; dy++) {
                        for (let dx = -apertureRadius; dx <= apertureRadius; dx++) {
                            const r2 = dx * dx + dy * dy;
                            if (r2 <= apertureRadius * apertureRadius) {
                                const sample = imageGray(centroid.x + dx, centroid.y + dy);
                                if (sample >= 252) {
                                    saturated += 1;
                                }
                                const w = Math.max(0, sample - localBg);
                                flux += w;
                                if (r2 <= coreRadius2) {
                                    coreFlux += w;
                                }
                                if (r2 >= outerRadius2) {
                                    outerFlux += w;
                                }
                                if (r2 >= shoulderInner2 && r2 <= shoulderOuter2) {
                                    shoulderFlux += w;
                                    shoulderCount += 1;
                                }
                                moment += w * r2;
                                mxx += w * dx * dx;
                                myy += w * dy * dy;
                                mxy += w * dx * dy;
                            }
                        }
                    }
                    if (flux <= 0) {
                        continue;
                    }
                    radius2 = moment / flux;
                    const trace = (mxx + myy) / flux;
                    const delta = Math.hypot((mxx - myy) / flux, 2 * mxy / flux);
                    const minor = Math.max(1e-6, 0.5 * (trace - delta));
                    const major = Math.max(minor, 0.5 * (trace + delta));
                    elongation = Math.sqrt(major / minor);
                    coreFluxFraction = coreFlux / flux;
                    outerFluxFraction = outerFlux / flux;
                    peakDominance = Math.max(0, peak - localBg) /
                        Math.max(1, shoulderCount > 0 ? shoulderFlux / shoulderCount : 0);
                    if (radius2 > 0.3 * starRadius * starRadius && apertureRadius === centroidRadius) {
                        centroid = weightedCentroid(x, y, wideCentroidRadius, localBg);
                        peak = imageGray(centroid.x, centroid.y);
                        continue;
                    }
                    break;
                }
                const saturatedLimit = Math.max(18, 0.55 * Math.PI * wideCentroidRadius * wideCentroidRadius);
                if (flux <= 0 || !Number.isFinite(centroid.x) || !Number.isFinite(centroid.y) ||
                        saturated > saturatedLimit) {
                    continue;
                }
                if (radius2 < 0.25 || radius2 > maxRadius2 || elongation > 3.4) {
                    continue;
                }
                const coreShapeFactor = Math.pow(
                    Math.max(0.12, Math.min(1, coreFluxFraction / 0.14)),
                    1.5
                );
                const peakShapeFactor = Math.pow(
                    Math.max(0.12, Math.min(1, peakDominance / 1.08)),
                    1.4
                );
                const outerShapePenalty = Math.pow(
                    1 + Math.max(0, outerFluxFraction - 0.58) * 4.0,
                    1.35
                );
                const elongationPenalty = Math.pow(Math.max(1, elongation), 1.7);
                const centroidOffset = Math.hypot(centroid.x - x, centroid.y - y);
                const centroidOffsetPenalty = Math.pow(1 + Math.max(0, centroidOffset - 0.8), 1.15);
                const compactness = peakContrast / Math.max(1, Math.sqrt(radius2));
                const roundnessFactor = coreShapeFactor * peakShapeFactor;
                const score = compactness * Math.sqrt(Math.max(1, flux)) * roundnessFactor /
                    (elongationPenalty * outerShapePenalty * centroidOffsetPenalty);
                candidates.push({
                    x: centroid.x,
                    y: centroid.y,
                    peakValue: value,
                    peakContrast,
                    localSigma,
                    peak,
                    flux,
                    background: localBg,
                    radius: Math.sqrt(radius2),
                    elongation,
                    coreFluxFraction,
                    outerFluxFraction,
                    peakDominance,
                    centroidOffset,
                    roundnessFactor,
                    score,
                });
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        return {
            key: detectorCacheKey(starRadius),
            starRadius,
            bg,
            sigma,
            candidates,
            rawCandidateCount,
            status: `DAO-style detector: bg ${bg.toFixed(1)}, sigma ${sigma.toFixed(1)}, ` +
                `cached ${candidates.length}/${rawCandidateCount} candidates at radius ${starRadius} px`,
        };
    }

    function applyDetectorThreshold(cache) {
        const thresholdSigma = 2.0;
        const preThreshold = cache.bg + Math.max(2, 0.35 * thresholdSigma * cache.sigma);
        const candidates = cache.candidates.filter(candidate =>
            candidate.peakValue >= preThreshold &&
            candidate.peakContrast >= Math.max(
                thresholdSigma * candidate.localSigma,
                3 + 2 * thresholdSigma
            )
        );
        const selected = [];
        const suppression2 = 8 * 8;
        const maxDetections = 250;
        for (const candidate of candidates) {
            if (selected.length >= maxDetections) {
                break;
            }
            let tooClose = false;
            for (const existing of selected) {
                const dx = existing.x - candidate.x;
                const dy = existing.y - candidate.y;
                if (dx * dx + dy * dy < suppression2) {
                    tooClose = true;
                    break;
                }
            }
            if (!tooClose) {
                selected.push({...candidate, id: selected.length + 1});
            }
        }
        state.detectedStars = selected.map((det, i) => ({...det, rank: i + 1}));
        state.detectorStatus = `${cache.status}; ` +
            `prefilter ${preThreshold.toFixed(1)}, threshold ${thresholdSigma.toFixed(1)} local sigma, ` +
            `${candidates.length} thresholded candidates, max ${maxDetections}`;
        updateAutoMatches();
    }

    function detectImageStars() {
        state.detectedStars = [];
        state.autoMatches = [];
        if (!state.imagePixels || !state.image) {
            state.detectorCache = null;
            state.detectorStatus = "detector: image readback unavailable";
            return;
        }

        const starRadius = detectorStarRadius();
        const key = detectorCacheKey(starRadius);
        if (!state.detectorCache || state.detectorCache.key !== key) {
            state.deletedDetectionIds = new Set();
            state.detectorCache = buildDetectorCandidateCache(starRadius);
        }
        applyDetectorThreshold(state.detectorCache);
    }

    async function detectBrightImageStarsForAutoIdentify(maxDetections = 50, detectorOptions = {}) {
        state.detectedStars = [];
        state.autoMatches = [];
        state.deletedDetectionIds = new Set();
        if (!state.imagePixels || !state.image || !window.AidaStarDetector) {
            state.detectorCache = null;
            state.detectorStatus = "fast detector: image readback unavailable";
            return [];
        }

        const {
            maskPredicate: optionMaskPredicate,
            regionBounds,
            ...detectorRest
        } = detectorOptions || {};
        const inRegion = (x, y) => !regionBounds ||
            x >= regionBounds.x0 && x <= regionBounds.x1 &&
            y >= regionBounds.y0 && y <= regionBounds.y1;
        const result = await window.AidaStarDetector.detectBrightStars(state.imagePixels, {
            maxDetections,
            ...detectorRest,
            maskPredicate: (x, y) =>
                !inRegion(x, y) ||
                isMaskedImagePixel(x, y) ||
                isJunkStarFinderPixel(x, y) ||
                Boolean(optionMaskPredicate && optionMaskPredicate(x, y)),
            onProgress: (percent, text) => setLoadingProgress(18 + 52 * percent / 100, text),
            yieldFn: async () => {
                await yieldToBrowser();
            },
        });
        state.detectionGeneration += 1;
        state.detectedStars = result.detections.map(detection => ({
            ...detection,
            generation: state.detectionGeneration,
        }));
        state.detectorStatus = result.status;
        updateAutoMatches();
        return state.detectedStars;
    }

    function scheduleDetectImageStars() {
        if (detectorUpdateTimer) {
            window.clearTimeout(detectorUpdateTimer);
        }
        detectorUpdateTimer = window.setTimeout(() => {
            detectorUpdateTimer = null;
            detectImageStars();
            render();
        }, 160);
    }

    function hideZoomCanvas() {
        zoomCanvas.classList.remove("visible");
    }

    function updateZoomCanvas(event) {
        if ((!state.zoomMode && !state.starMatchMode) || !state.imagePixels || !state.image) {
            hideZoomCanvas();
            return;
        }
        const point = eventToImagePixel(event);
        if (!point) {
            hideZoomCanvas();
            return;
        }

        const size = 100;
        const half = size / 2;
        const displayPixels = displayImagePixels();
        const source = displayPixels.data;
        const width = state.image.width;
        const height = state.image.height;
        const brightness = Number(controls.brightness.value) || 0;
        const contrast = Number(controls.contrast.value) || 1;
        const displayChannel = value => {
            const adjusted = ((value / 255) - 0.5) * contrast + 0.5 + brightness;
            return Math.round(Math.max(0, Math.min(1, adjusted)) * 255);
        };
        const patch = zoomContext.createImageData(size, size);
        for (let py = 0; py < size; py++) {
            const sy = Math.round(point.y - half + py);
            for (let px = 0; px < size; px++) {
                const sx = Math.round(point.x - half + px);
                const dst = 4 * (py * size + px);
                if (sx < 0 || sx >= width || sy < 0 || sy >= height) {
                    patch.data[dst] = 0;
                    patch.data[dst + 1] = 0;
                    patch.data[dst + 2] = 0;
                    patch.data[dst + 3] = 255;
                    continue;
                }
                const src = 4 * (sy * width + sx);
                patch.data[dst] = displayChannel(source[src]);
                patch.data[dst + 1] = displayChannel(source[src + 1]);
                patch.data[dst + 2] = displayChannel(source[src + 2]);
                patch.data[dst + 3] = 255;
            }
        }
        zoomContext.putImageData(patch, 0, 0);
        zoomContext.strokeStyle = "rgba(250, 204, 21, 0.95)";
        zoomContext.lineWidth = 1;
        zoomContext.beginPath();
        zoomContext.moveTo(50, 36);
        zoomContext.lineTo(50, 46);
        zoomContext.moveTo(50, 54);
        zoomContext.lineTo(50, 64);
        zoomContext.moveTo(36, 50);
        zoomContext.lineTo(46, 50);
        zoomContext.moveTo(54, 50);
        zoomContext.lineTo(64, 50);
        zoomContext.stroke();
        drawKdeContoursOnZoom(point, size, half);

        const panelRect = canvas.parentElement.getBoundingClientRect();
        const cssX = event.clientX - panelRect.left;
        const cssY = event.clientY - panelRect.top;
        const zoomSize = 300;
        let left = cssX + 18;
        let top = cssY + 18;
        if (left + zoomSize > panelRect.width) {
            left = cssX - zoomSize - 18;
        }
        if (top + zoomSize > panelRect.height) {
            top = cssY - zoomSize - 18;
        }
        zoomCanvas.style.left = `${Math.max(8, left)}px`;
        zoomCanvas.style.top = `${Math.max(8, top)}px`;
        zoomCanvas.classList.add("visible");
    }

    function drawKdeContoursOnZoom(point, size, half) {
        if (!state.centroidPreview || !state.centroidDensity ||
                Date.now() >= state.centroidPreview.expiresAt) {
            return;
        }
        const cx = state.centroidPreview.x - point.x + half;
        const cy = state.centroidPreview.y - point.y + half;
        if (cx < -20 || cx > size + 20 || cy < -20 || cy > size + 20) {
            return;
        }
        zoomContext.save();
        drawDensityContoursOnZoom(point);
        zoomContext.strokeStyle = "rgba(255, 255, 255, 0.9)";
        zoomContext.beginPath();
        zoomContext.moveTo(cx - 4, cy);
        zoomContext.lineTo(cx + 4, cy);
        zoomContext.moveTo(cx, cy - 4);
        zoomContext.lineTo(cx, cy + 4);
        zoomContext.stroke();
        zoomContext.restore();
    }

    function drawDensityContoursOnZoom(point) {
        const density = state.centroidDensity;
        const thresholds = [0.72, 0.5, 0.32];
        const colors = ["rgba(94, 234, 212, 0.95)", "rgba(94, 234, 212, 0.68)", "rgba(94, 234, 212, 0.42)"];
        zoomContext.lineWidth = 1.1;
        for (let level = 0; level < thresholds.length; level++) {
            zoomContext.strokeStyle = colors[level];
            const threshold = density.maxValue * thresholds[level];
            zoomContext.beginPath();
            for (let y = 0; y < density.height - 1; y++) {
                for (let x = 0; x < density.width - 1; x++) {
                    const v00 = density.values[y * density.width + x];
                    const v10 = density.values[y * density.width + x + 1];
                    const v01 = density.values[(y + 1) * density.width + x];
                    const v11 = density.values[(y + 1) * density.width + x + 1];
                    addMarchingSquareContour(density, point, x, y, v00, v10, v11, v01, threshold);
                }
            }
            zoomContext.stroke();
        }
    }

    function addMarchingSquareContour(density, point, x, y, v00, v10, v11, v01, threshold) {
        const points = [];
        const addEdgePoint = (edge, a, b) => {
            const denom = b.value - a.value;
            const t = Math.abs(denom) > 1e-12 ? (threshold - a.value) / denom : 0.5;
            const fx = a.x + Math.max(0, Math.min(1, t)) * (b.x - a.x);
            const fy = a.y + Math.max(0, Math.min(1, t)) * (b.y - a.y);
            points[edge] = {
                x: density.originX + fx / density.upsample - point.x + 50,
                y: density.originY + fy / density.upsample - point.y + 50,
            };
        };
        const p00 = {x, y, value: v00};
        const p10 = {x: x + 1, y, value: v10};
        const p11 = {x: x + 1, y: y + 1, value: v11};
        const p01 = {x, y: y + 1, value: v01};
        if ((v00 >= threshold) !== (v10 >= threshold)) addEdgePoint(0, p00, p10);
        if ((v10 >= threshold) !== (v11 >= threshold)) addEdgePoint(1, p10, p11);
        if ((v11 >= threshold) !== (v01 >= threshold)) addEdgePoint(2, p11, p01);
        if ((v01 >= threshold) !== (v00 >= threshold)) addEdgePoint(3, p01, p00);
        const present = points.filter(Boolean);
        if (present.length === 2) {
            zoomContext.moveTo(present[0].x, present[0].y);
            zoomContext.lineTo(present[1].x, present[1].y);
        } else if (present.length === 4) {
            zoomContext.moveTo(points[0].x, points[0].y);
            zoomContext.lineTo(points[1].x, points[1].y);
            zoomContext.moveTo(points[2].x, points[2].y);
            zoomContext.lineTo(points[3].x, points[3].y);
        }
    }

    function closeDensityPopup() {
        densityPopup.classList.remove("visible");
        densityPopup.setAttribute("aria-hidden", "true");
    }

    function clearDensityEstimate() {
        state.centroidPreview = null;
        state.centroidDensity = null;
        closeDensityPopup();
        hideZoomCanvas();
    }

    function showDensityPopup(event = null) {
        if (!state.centroidPreview || !state.centroidDensity) {
            return;
        }
        positionDensityPopupAwayFromEvent(event);
        densityPopup.classList.add("visible");
        densityPopup.setAttribute("aria-hidden", "false");
        densityPopupSubtitle.textContent =
            `selected x/y ${state.centroidPreview.x.toFixed(4)}, ${state.centroidPreview.y.toFixed(4)} px; ` +
            `fine-grid value ${state.centroidDensity.selectedValue.toFixed(3)}`;
        drawDensityPopup();
    }

    function positionDensityPopupAwayFromEvent(event) {
        const panel = canvas.parentElement.getBoundingClientRect();
        const popupWidth = Math.min(620, Math.max(280, panel.width - 36));
        const popupHeight = Math.min(560, Math.max(360, panel.height - 36));
        let clickX = panel.width / 2;
        let clickY = panel.height / 2;
        if (event) {
            clickX = event.clientX - panel.left;
            clickY = event.clientY - panel.top;
        }
        const margin = 18;
        const candidates = [
            {left: margin, top: margin},
            {left: panel.width - popupWidth - margin, top: margin},
            {left: margin, top: panel.height - popupHeight - margin},
            {left: panel.width - popupWidth - margin, top: panel.height - popupHeight - margin},
        ].map(candidate => ({
            left: Math.max(margin, Math.min(panel.width - popupWidth - margin, candidate.left)),
            top: Math.max(margin, Math.min(panel.height - popupHeight - margin, candidate.top)),
        }));
        candidates.sort((a, b) => {
            const acx = a.left + popupWidth / 2;
            const acy = a.top + popupHeight / 2;
            const bcx = b.left + popupWidth / 2;
            const bcy = b.top + popupHeight / 2;
            return Math.hypot(bcx - clickX, bcy - clickY) - Math.hypot(acx - clickX, acy - clickY);
        });
        densityPopup.style.width = `${popupWidth}px`;
        densityPopup.style.left = `${candidates[0].left}px`;
        densityPopup.style.top = `${candidates[0].top}px`;
        densityPopup.style.right = "auto";
        densityPopup.style.bottom = "auto";
    }

    function drawDensityPopup() {
        const density = state.centroidDensity;
        const selected = state.centroidPreview;
        if (!density || !selected) {
            return;
        }
        const w = densityCanvas.width;
        const h = densityCanvas.height;
        const plot = {x0: 58, y0: 24, w: w - 86, h: h - 78};
        densityContext.clearRect(0, 0, w, h);
        densityContext.fillStyle = "#020617";
        densityContext.fillRect(0, 0, w, h);
        densityContext.fillStyle = "#dbeafe";
        densityContext.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        densityContext.fillText("Gaussian-smoothed density contours from 40x interpolated image patch", plot.x0, 16);

        const sx = fineX => plot.x0 + (fineX / (density.width - 1)) * plot.w;
        const sy = fineY => plot.y0 + (fineY / (density.height - 1)) * plot.h;
        drawDensityBitmapUnderlay(density, plot);
        densityContext.strokeStyle = "rgba(148, 163, 184, 0.42)";
        densityContext.lineWidth = 1;
        densityContext.strokeRect(plot.x0, plot.y0, plot.w, plot.h);
        for (let i = 0; i <= 4; i++) {
            const x = plot.x0 + (i / 4) * plot.w;
            const y = plot.y0 + (i / 4) * plot.h;
            densityContext.beginPath();
            densityContext.moveTo(x, plot.y0);
            densityContext.lineTo(x, plot.y0 + plot.h);
            densityContext.moveTo(plot.x0, y);
            densityContext.lineTo(plot.x0 + plot.w, y);
            densityContext.strokeStyle = "rgba(51, 65, 85, 0.62)";
            densityContext.stroke();
        }

        const levels = [0.9, 0.78, 0.64, 0.5, 0.38, 0.28, 0.18, 0.1];
        for (let i = 0; i < levels.length; i++) {
            densityContext.beginPath();
            densityContext.strokeStyle = `hsla(${170 + i * 9}, 86%, ${68 - i * 3}%, ${0.95 - i * 0.055})`;
            densityContext.lineWidth = i < 2 ? 1.8 : 1.2;
            const threshold = density.maxValue * levels[i];
            for (let y = 0; y < density.height - 1; y++) {
                for (let x = 0; x < density.width - 1; x++) {
                    const v00 = density.values[y * density.width + x];
                    const v10 = density.values[y * density.width + x + 1];
                    const v01 = density.values[(y + 1) * density.width + x];
                    const v11 = density.values[(y + 1) * density.width + x + 1];
                    addPopupContourSegment(x, y, v00, v10, v11, v01, threshold, sx, sy);
                }
            }
            densityContext.stroke();
        }

        const px = sx(density.selectedFineX);
        const py = sy(density.selectedFineY);
        densityContext.strokeStyle = "#fef08a";
        densityContext.fillStyle = "#fef08a";
        densityContext.lineWidth = 1.5;
        densityContext.beginPath();
        densityContext.arc(px, py, 5, 0, 2 * Math.PI);
        densityContext.stroke();
        densityContext.beginPath();
        densityContext.moveTo(px - 10, py);
        densityContext.lineTo(px + 10, py);
        densityContext.moveTo(px, py - 10);
        densityContext.lineTo(px, py + 10);
        densityContext.stroke();

        densityContext.fillStyle = "rgba(15, 23, 42, 0.88)";
        densityContext.fillRect(plot.x0, h - 46, plot.w, 30);
        densityContext.fillStyle = "#e5e7eb";
        densityContext.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        densityContext.fillText(
            `selected interpolated pixel: (${density.selectedFineX}, ${density.selectedFineY}), value ${density.selectedValue.toFixed(3)}`,
            plot.x0 + 8,
            h - 27
        );
        densityContext.fillStyle = "#a7f3d0";
        densityContext.fillText(
            `image x/y ${selected.x.toFixed(4)}, ${selected.y.toFixed(4)}; background ${density.background.toFixed(2)}; Gaussian support ${density.gaussianSupportPx} fine px`,
            plot.x0 + 8,
            h - 12
        );
    }

    function drawDensityBitmapUnderlay(density, plot) {
        if (!density.rawValues) {
            return;
        }
        const patchCanvas = document.createElement("canvas");
        patchCanvas.width = density.width;
        patchCanvas.height = density.height;
        const patchContext = patchCanvas.getContext("2d");
        const patchData = patchContext.createImageData(density.width, density.height);
        const values = Array.from(density.rawValues);
        const sorted = values.slice().sort((a, b) => a - b);
        const lo = sorted[Math.floor(0.02 * (sorted.length - 1))] ?? 0;
        const hi = sorted[Math.floor(0.98 * (sorted.length - 1))] ?? 255;
        const scale = hi > lo ? 255 / (hi - lo) : 1;
        for (let y = 0; y < density.height; y++) {
            for (let x = 0; x < density.width; x++) {
                const srcIndex = y * density.width + x;
                const dstIndex = 4 * (y * density.width + x);
                const value = Math.max(0, Math.min(255, (values[srcIndex] - lo) * scale));
                patchData.data[dstIndex] = value;
                patchData.data[dstIndex + 1] = value;
                patchData.data[dstIndex + 2] = value;
                patchData.data[dstIndex + 3] = 255;
            }
        }
        patchContext.putImageData(patchData, 0, 0);
        densityContext.save();
        densityContext.imageSmoothingEnabled = true;
        densityContext.globalAlpha = 0.94;
        densityContext.drawImage(patchCanvas, plot.x0, plot.y0, plot.w, plot.h);
        densityContext.restore();
    }

    function addPopupContourSegment(x, y, v00, v10, v11, v01, threshold, sx, sy) {
        const points = [];
        const addEdgePoint = (edge, a, b) => {
            const denom = b.value - a.value;
            const t = Math.abs(denom) > 1e-12 ? (threshold - a.value) / denom : 0.5;
            const fx = a.x + Math.max(0, Math.min(1, t)) * (b.x - a.x);
            const fy = a.y + Math.max(0, Math.min(1, t)) * (b.y - a.y);
            points[edge] = {x: sx(fx), y: sy(fy)};
        };
        const p00 = {x, y, value: v00};
        const p10 = {x: x + 1, y, value: v10};
        const p11 = {x: x + 1, y: y + 1, value: v11};
        const p01 = {x, y: y + 1, value: v01};
        if ((v00 >= threshold) !== (v10 >= threshold)) addEdgePoint(0, p00, p10);
        if ((v10 >= threshold) !== (v11 >= threshold)) addEdgePoint(1, p10, p11);
        if ((v11 >= threshold) !== (v01 >= threshold)) addEdgePoint(2, p11, p01);
        if ((v01 >= threshold) !== (v00 >= threshold)) addEdgePoint(3, p01, p00);
        const present = points.filter(Boolean);
        if (present.length === 2) {
            densityContext.moveTo(present[0].x, present[0].y);
            densityContext.lineTo(present[1].x, present[1].y);
        } else if (present.length === 4) {
            densityContext.moveTo(points[0].x, points[0].y);
            densityContext.lineTo(points[1].x, points[1].y);
            densityContext.moveTo(points[2].x, points[2].y);
            densityContext.lineTo(points[3].x, points[3].y);
        }
    }

    function uploadImagePixelsToTexture() {
        if (!state.texture || !state.imagePixels) {
            return;
        }
        gl.bindTexture(gl.TEXTURE_2D, state.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, displayImagePixels());
    }

    function gaussianKernel(sigma) {
        const radius = Math.max(1, Math.ceil(3 * sigma));
        const kernel = [];
        let sum = 0;
        for (let i = -radius; i <= radius; i++) {
            const value = Math.exp(-0.5 * (i / sigma) * (i / sigma));
            kernel.push(value);
            sum += value;
        }
        return kernel.map(value => value / sum);
    }

    function downsampleGrayImage(imageData, factor) {
        const width = imageData.width;
        const height = imageData.height;
        const smallWidth = Math.ceil(width / factor);
        const smallHeight = Math.ceil(height / factor);
        const sums = new Float32Array(smallWidth * smallHeight);
        const counts = new Uint16Array(smallWidth * smallHeight);
        const data = imageData.data;
        for (let y = 0; y < height; y++) {
            const sy = Math.floor(y / factor);
            for (let x = 0; x < width; x++) {
                const sx = Math.floor(x / factor);
                const src = 4 * (y * width + x);
                const dst = sy * smallWidth + sx;
                sums[dst] += 0.2126 * data[src] + 0.7152 * data[src + 1] + 0.0722 * data[src + 2];
                counts[dst] += 1;
            }
        }
        for (let i = 0; i < sums.length; i++) {
            sums[i] /= Math.max(1, counts[i]);
        }
        return {width: smallWidth, height: smallHeight, gray: sums};
    }

    function convolveHorizontal(src, width, height, kernel) {
        const radius = Math.floor(kernel.length / 2);
        const dst = new Float32Array(src.length);
        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                let sum = 0;
                for (let k = -radius; k <= radius; k++) {
                    const ix = Math.max(0, Math.min(width - 1, x + k));
                    sum += src[row + ix] * kernel[k + radius];
                }
                dst[row + x] = sum;
            }
        }
        return dst;
    }

    function convolveVertical(src, width, height, kernel) {
        const radius = Math.floor(kernel.length / 2);
        const dst = new Float32Array(src.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let sum = 0;
                for (let k = -radius; k <= radius; k++) {
                    const iy = Math.max(0, Math.min(height - 1, y + k));
                    sum += src[iy * width + x] * kernel[k + radius];
                }
                dst[y * width + x] = sum;
            }
        }
        return dst;
    }

    function blurredGrayBackground(imageData, widthPx) {
        const factor = Math.max(1, Math.min(12, Math.round(widthPx / 16)));
        const small = downsampleGrayImage(imageData, factor);
        const sigma = Math.max(1, widthPx / factor);
        const kernel = gaussianKernel(sigma);
        const horizontal = convolveHorizontal(small.gray, small.width, small.height, kernel);
        const blurred = convolveVertical(horizontal, small.width, small.height, kernel);
        return {factor, width: small.width, height: small.height, blurred};
    }

    function sampledBackground(bg, x, y) {
        const gx = Math.max(0, Math.min(bg.width - 1, x / bg.factor));
        const gy = Math.max(0, Math.min(bg.height - 1, y / bg.factor));
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const x1 = Math.min(bg.width - 1, x0 + 1);
        const y1 = Math.min(bg.height - 1, y0 + 1);
        const tx = gx - x0;
        const ty = gy - y0;
        const a = bg.blurred[y0 * bg.width + x0] * (1 - tx) + bg.blurred[y0 * bg.width + x1] * tx;
        const b = bg.blurred[y1 * bg.width + x0] * (1 - tx) + bg.blurred[y1 * bg.width + x1] * tx;
        return a * (1 - ty) + b * ty;
    }

    function highPassImageData(imageData, widthPx) {
        const bg = blurredGrayBackground(imageData, widthPx);
        const out = new ImageData(imageData.width, imageData.height);
        const src = imageData.data;
        const dst = out.data;
        for (let y = 0; y < imageData.height; y++) {
            for (let x = 0; x < imageData.width; x++) {
                const k = 4 * (y * imageData.width + x);
                const gray = 0.2126 * src[k] + 0.7152 * src[k + 1] + 0.0722 * src[k + 2];
                const value = Math.max(0, Math.min(255, 18 + 4.0 * (gray - sampledBackground(bg, x, y))));
                dst[k] = value;
                dst[k + 1] = value;
                dst[k + 2] = value;
                dst[k + 3] = src[k + 3];
            }
        }
        return out;
    }

    function displayImagePixels() {
        if (!controls.highPassImage.checked || !state.imagePixels) {
            state.displayPixels = null;
            state.highPassCacheKey = "";
            return state.imagePixels;
        }
        const widthPx = Math.max(10, Math.min(300, Number(controls.highPassWidth.value) || 100));
        const cacheKey = `${state.imageName}:${state.maskRegions.length}:${widthPx}`;
        if (state.displayPixels && state.highPassCacheKey === cacheKey) {
            return state.displayPixels;
        }
        state.displayPixels = highPassImageData(state.imagePixels, widthPx);
        state.highPassCacheKey = cacheKey;
        return state.displayPixels;
    }

    function maskImageRegion(rawX, rawY, radius = 100) {
        if (!state.imagePixels || !state.image) {
            return false;
        }
        const cx = Math.round(rawX);
        const cy = Math.round(rawY);
        const r = Math.round(radius);
        const r2 = r * r;
        const width = state.image.width;
        const height = state.image.height;
        const data = state.imagePixels.data;
        const x0 = Math.max(0, cx - r);
        const x1 = Math.min(width - 1, cx + r);
        const y0 = Math.max(0, cy - r);
        const y1 = Math.min(height - 1, cy + r);
        for (let y = y0; y <= y1; y++) {
            const dy = y - cy;
            for (let x = x0; x <= x1; x++) {
                const dx = x - cx;
                if (dx * dx + dy * dy > r2) {
                    continue;
                }
                const k = 4 * (y * width + x);
                data[k] = 0;
                data[k + 1] = 0;
                data[k + 2] = 0;
                data[k + 3] = 255;
            }
        }
        state.maskRegions.push({x: cx, y: cy, radius: r});
        uploadImagePixelsToTexture();
        detectImageStars();
        updateAutoMatches();
        return true;
    }

    function solveLinearSystem(a, b) {
        const n = b.length;
        const m = a.map((row, i) => row.concat([b[i]]));
        for (let col = 0; col < n; col++) {
            let pivot = col;
            for (let r = col + 1; r < n; r++) {
                if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) {
                    pivot = r;
                }
            }
            if (Math.abs(m[pivot][col]) < 1e-12) {
                return null;
            }
            [m[col], m[pivot]] = [m[pivot], m[col]];
            const div = m[col][col];
            for (let c = col; c <= n; c++) {
                m[col][c] /= div;
            }
            for (let r = 0; r < n; r++) {
                if (r === col) {
                    continue;
                }
                const factor = m[r][col];
                for (let c = col; c <= n; c++) {
                    m[r][c] -= factor * m[col][c];
                }
            }
        }
        return m.map(row => row[n]);
    }

    function weightedCentroid(cx, cy, radius, background = null) {
        let sum = 0;
        let sx = 0;
        let sy = 0;
        const bg = background === null ? imageGray(cx - radius, cy - radius) : background;
        const sigma = Math.max(1.5, radius / 2.2);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const r2 = dx * dx + dy * dy;
                if (r2 > radius * radius) {
                    continue;
                }
                const weight = Math.max(0, imageGray(cx + dx, cy + dy) - bg) * Math.exp(-0.5 * r2 / (sigma * sigma));
                sum += weight;
                sx += weight * (cx + dx);
                sy += weight * (cy + dy);
            }
        }
        if (sum <= 1e-9) {
            return {x: cx, y: cy, method: "peak"};
        }
        return {x: sx / sum, y: sy / sum, method: "moment"};
    }

    function gaussianCentroid(clickX, clickY) {
        if (!state.imagePixels) {
            return {x: clickX, y: clickY, method: "click"};
        }
        const searchRadius = 8;
        let peakX = Math.round(clickX);
        let peakY = Math.round(clickY);
        let peak = -Infinity;
        for (let dy = -searchRadius; dy <= searchRadius; dy++) {
            for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                const value = imageGray(clickX + dx, clickY + dy);
                if (value > peak) {
                    peak = value;
                    peakX = Math.round(clickX + dx);
                    peakY = Math.round(clickY + dy);
                }
            }
        }

        const bgSamples = [];
        for (let dy = -searchRadius; dy <= searchRadius; dy++) {
            for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                const r = Math.hypot(dx, dy);
                if (r >= searchRadius - 2 && r <= searchRadius) {
                    bgSamples.push(imageGray(peakX + dx, peakY + dy));
                }
            }
        }
        const background = median(bgSamples);

        // Iterate a Gaussian-weighted centroid around the local peak. This is
        // more stable for clipped or slightly trailed stars than using all
        // pixels in a square window.
        let center = weightedCentroid(peakX, peakY, 5, background);
        for (let iter = 0; iter < 4; iter++) {
            const next = weightedCentroid(center.x, center.y, 5, background);
            if (Math.hypot(next.x - center.x, next.y - center.y) < 0.02) {
                center = next;
                break;
            }
            center = next;
        }

        const radius = 4;
        const normal = Array.from({length: 6}, () => Array(6).fill(0));
        const rhs = Array(6).fill(0);
        let samples = 0;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const px = center.x + dx;
                const py = center.y + dy;
                const r2 = dx * dx + dy * dy;
                const intensity = imageGray(px, py) - background;
                if (intensity <= 2 || r2 > radius * radius) {
                    continue;
                }
                const row = [1, dx, dy, dx * dx, dx * dy, dy * dy];
                const value = Math.log(intensity);
                for (let r = 0; r < 6; r++) {
                    rhs[r] += row[r] * value;
                    for (let c = 0; c < 6; c++) {
                        normal[r][c] += row[r] * row[c];
                    }
                }
                samples += 1;
            }
        }
        if (samples < 8) {
            return center;
        }

        const p = solveLinearSystem(normal, rhs);
        if (!p) {
            return center;
        }
        const [, ax, ay, bxx, bxy, byy] = p;
        const det = 4 * bxx * byy - bxy * bxy;
        if (Math.abs(det) < 1e-9 || bxx >= 0 || byy >= 0) {
            return center;
        }
        const x0 = (bxy * ay - 2 * byy * ax) / det;
        const y0 = (bxy * ax - 2 * bxx * ay) / det;
        if (Math.abs(x0) > radius + 1 || Math.abs(y0) > radius + 1) {
            return center;
        }
        const fitX = center.x + x0;
        const fitY = center.y + y0;
        if (Math.hypot(fitX - clickX, fitY - clickY) > searchRadius + 2) {
            return center;
        }
        return {x: fitX, y: fitY, method: "gaussian"};
    }

    function kdeCentroid(clickX, clickY) {
        if (!state.imagePixels) {
            return {x: clickX, y: clickY, sigma: 0, method: "click"};
        }
        const result = AidaCentroid.estimateCentroid(clickX, clickY, imageGrayInterpolated);
        state.centroidDensity = result.density;
        return {x: result.x, y: result.y, sigma: result.sigma, method: result.method};
    }

    function nearestProjectedStar(event) {
        const [cx, cy] = eventToCanvasPixel(event);
        return nearestProjectedStarFromCanvasPixel(cx, cy);
    }

    function isMatchedDetection(detection) {
        return state.matches.some(match => match.detectionId === detection.id);
    }

    function nearestDetectedStar(event) {
        const imagePoint = eventToImagePixel(event);
        const detections = activeDetectedStars();
        if (!imagePoint || detections.length === 0) {
            return null;
        }
        let best = null;
        let bestD2 = Infinity;
        for (const detection of detections) {
            if (isMatchedDetection(detection)) {
                continue;
            }
            const dx = detection.x - imagePoint.x;
            const dy = detection.y - imagePoint.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                best = detection;
                bestD2 = d2;
            }
        }
        const maxDist = 18;
        return best && bestD2 <= maxDist * maxDist ? {...best, distancePx: Math.sqrt(bestD2)} : null;
    }

    function nearestProjectedStarFromCanvasPixel(cx, cy) {
        const maxMag = Number(controls.maxMag.value) || 4;
        const margin = 20 * (window.devicePixelRatio || 1);
        let best = null;
        let bestD2 = Infinity;
        for (const star of state.projected) {
            if (star.mag > maxMag || isMatchedCatalogStar(star)) {
                continue;
            }
            const [x, y] = canvasPixelFromImagePixel(star.x, star.y);
            if (!Number.isFinite(x) || !Number.isFinite(y) ||
                    x < -margin || x > canvas.width + margin ||
                    y < -margin || y > canvas.height + margin) {
                continue;
            }
            const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
            if (d2 < bestD2) {
                const [displayedX, displayedY] = displayedImagePixelFromModelImagePixel(star.x, star.y);
                const [rawX, rawY] = rawImagePixelFromDisplayedImagePixel(displayedX, displayedY);
                best = {...star, displayedX, displayedY, rawX, rawY};
                bestD2 = d2;
            }
        }
        const maxDist = 35 * (window.devicePixelRatio || 1);
        return best && bestD2 <= maxDist * maxDist ? {...best, distancePx: Math.sqrt(bestD2) / (window.devicePixelRatio || 1)} : null;
    }

    function removeNearestMatchedStar(event) {
        if (state.matches.length === 0) {
            return false;
        }
        const [cx, cy] = eventToCanvasPixel(event);
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const lat = Number(controls.latDeg.value) || 0;
        const lon = Number(controls.lonDeg.value) || 0;
        const optmod = Number(controls.optmod.value);
        const optpar = currentOptpar();
        let bestIndex = -1;
        let bestD2 = Infinity;
        for (let i = 0; i < state.matches.length; i++) {
            const match = state.matches[i];
            const imagePoint = imageMarkerCanvasPixel(match.image.x, match.image.y);
            const imageD2 = (imagePoint[0] - cx) * (imagePoint[0] - cx) +
                (imagePoint[1] - cy) * (imagePoint[1] - cy);
            if (imageD2 < bestD2) {
                bestD2 = imageD2;
                bestIndex = i;
            }

            const azze = AidaTools.radecToAzZe(match.catalog.raHours, match.catalog.decDeg, date, lat, lon);
            const xy = AidaTools.cameraModel(azze.az, azze.ze, optpar, optmod, state.image.width, state.image.height);
            if (Number.isFinite(xy.x) && Number.isFinite(xy.y)) {
                const catalogPoint = canvasPixelFromImagePixel(xy.x, xy.y);
                const catalogD2 = (catalogPoint[0] - cx) * (catalogPoint[0] - cx) +
                    (catalogPoint[1] - cy) * (catalogPoint[1] - cy);
                if (catalogD2 < bestD2) {
                    bestD2 = catalogD2;
                    bestIndex = i;
                }
            }
        }
        const maxDist = 20 * (window.devicePixelRatio || 1);
        if (bestIndex < 0 || bestD2 > maxDist * maxDist) {
            return false;
        }
        const [removed] = state.matches.splice(bestIndex, 1);
        state.matches.forEach((match, i) => {
            match.id = i + 1;
        });
        state.pendingMatch = null;
        state.lastFitVector = null;
        updateAutoMatches();
        state.fitMessage = `removed paired star ${removed.id}: ${removed.catalog.name || "(unnamed)"}`;
        render();
        return true;
    }

    function handleStarMatchClick(event) {
        const imagePoint = eventToImagePixel(event);
        if (!imagePoint) {
            state.fitMessage = "star match: click on an image star while holding s";
            render();
            return;
        }
        const centroid = kdeCentroid(imagePoint.x, imagePoint.y);
        state.pendingMatch = {
            image: {x: centroid.x, y: centroid.y, method: centroid.method},
            detectionId: null,
        };
        state.centroidPreview = {
            x: centroid.x,
            y: centroid.y,
            sigma: centroid.sigma,
            method: centroid.method,
            expiresAt: Infinity,
        };
        hideZoomCanvas();
        showDensityPopup(event);
        state.fitMessage = `image star selected with ${centroid.method}: x/y ` +
            `${centroid.x.toFixed(3)}, ${centroid.y.toFixed(3)}, sigma ${centroid.sigma.toFixed(2)} px; ` +
            "release s and click the matching catalog star";
        render();
    }

    function handleCatalogPairClick(event) {
        const star = nearestProjectedStar(event);
        if (!star) {
            state.fitMessage = "star match: click the matching red catalog star";
            render();
            return;
        }
        state.matches.push({
            id: state.matches.length + 1,
            image: state.pendingMatch.image,
            detectionId: null,
            catalog: {
                key: catalogKey(star),
                raHours: star.raHours,
                decDeg: star.decDeg,
                mag: star.mag,
                name: star.name,
                az: star.az,
                ze: star.ze,
            },
        });
        state.pendingMatch = null;
        clearDensityEstimate();
        state.showPickedMatchMarkers = true;
        playPairingRewardSound();
        render();
    }

    function handleDeletePairingClick(event) {
        if (!removeNearestMatchedStar(event)) {
            state.fitMessage = "delete pairing: no matched image or catalog star nearby";
            render();
        }
    }

    function requiredOptparLength(optmod = Number(controls.optmod.value) || 2) {
        return optmod === BROWN_CONRADY_OPTMOD ? 12 : 8;
    }

    function radialAlphaBoundsForFit(optmod = Number(controls.optmod.value) || 2) {
        if (optmod === 2) {
            return {lo: 0.1, hi: 1.0, strict: true};
        }
        if (optmod === 12) {
            return {lo: -2.5, hi: 2.5, strict: false};
        }
        if (optmod === BROWN_CONRADY_OPTMOD) {
            return {lo: -5.0, hi: 5.0, strict: false};
        }
        return {lo: 0.05, hi: 2.5, strict: false};
    }

    function fitParameterBounds(optmod = Number(controls.optmod.value) || 2) {
        const length = requiredOptparLength(optmod);
        const bounds = Array.from({length}, () => ({lo: -Infinity, hi: Infinity, strict: false}));
        bounds[0] = {lo: -10, hi: 10, minAbs: 0.05, strict: false};
        bounds[1] = {lo: -10, hi: 10, minAbs: 0.05, strict: false};
        bounds[2] = {lo: -90, hi: 90, strict: false};
        bounds[3] = {lo: -90, hi: 90, strict: false};
        bounds[4] = {lo: -720, hi: 720, strict: false};
        bounds[5] = {lo: -0.5, hi: 0.5, strict: false};
        bounds[6] = {lo: -0.5, hi: 0.5, strict: false};
        bounds[7] = radialAlphaBoundsForFit(optmod);
        if (optmod === BROWN_CONRADY_OPTMOD) {
            bounds[8] = {lo: -5, hi: 5, strict: false};
            bounds[9] = {lo: -5, hi: 5, strict: false};
            bounds[10] = {lo: -1, hi: 1, strict: false};
            bounds[11] = {lo: -1, hi: 1, strict: false};
        }
        return bounds;
    }

    function clampFitVectorToBounds(x, optmod = Number(controls.optmod.value) || 2) {
        const bounds = fitParameterBounds(optmod);
        const epsilon = 1e-9;
        return x.slice(0, bounds.length).map((value, index) => {
            const bound = bounds[index];
            let clipped = value;
            if (Number.isFinite(bound.lo) && clipped < bound.lo) {
                clipped = bound.lo;
            }
            if (Number.isFinite(bound.hi) && clipped > bound.hi) {
                clipped = bound.hi;
            }
            if (bound.strict && Number.isFinite(bound.lo) && clipped <= bound.lo) {
                clipped = bound.lo + epsilon;
            }
            if (bound.strict && Number.isFinite(bound.hi) && clipped >= bound.hi) {
                clipped = bound.hi - epsilon;
            }
            if (Number.isFinite(bound.minAbs) && Math.abs(clipped) < bound.minAbs) {
                clipped = clipped < 0 ? -bound.minAbs : bound.minAbs;
            }
            return clipped;
        });
    }

    function fitPenalty(x, optmod = Number(controls.optmod.value) || 2) {
        const bounds = fitParameterBounds(optmod);
        if (x.length < bounds.length) {
            return 1e12;
        }
        for (let i = 0; i < bounds.length; i += 1) {
            const value = x[i];
            const bound = bounds[i];
            if (!Number.isFinite(value) ||
                    Number.isFinite(bound.minAbs) && Math.abs(value) < bound.minAbs ||
                    bound.strict && (value <= bound.lo || value >= bound.hi) ||
                    !bound.strict && (value < bound.lo || value > bound.hi)) {
                return 1e12;
            }
        }
        return 0;
    }

    function matchResidualFactory(matchesForFit = fittingMatches()) {
        const date = AidaTools.datetimeLocalToDate(controls.timestampUtc.value);
        const lat = Number(controls.latDeg.value) || 0;
        const lon = Number(controls.lonDeg.value) || 0;
        const optmod = Number(controls.optmod.value);
        const rows = matchesForFit.map(match => {
            const azze = AidaTools.radecToAzZe(match.catalog.raHours, match.catalog.decDeg, date, lat, lon);
            return {az: azze.az, ze: azze.ze, image: match.image};
        });
        return x => {
            if (fitPenalty(x, optmod) > 0 || rows.length === 0) {
                return null;
            }
            const optpar = optparFromFitVector(x);
            const residuals = [];
            for (const row of rows) {
                const xy = AidaTools.cameraModel(row.az, row.ze, optpar, optmod, state.image.width, state.image.height);
                if (!Number.isFinite(xy.x) || !Number.isFinite(xy.y)) {
                    return null;
                }
                const [rawX, rawY] = rawImagePixelFromModelImagePixel(xy.x, xy.y);
                // Least-squares objective: after applying the same overlay and
                // image flips used on screen, model-projected catalog stars
                // should match the picked centroids in raw image pixels.
                residuals.push(rawX - row.image.x, rawY - row.image.y);
            }
            return residuals;
        };
    }

    function residualSumSquares(residuals) {
        if (!residuals) {
            return 1e12;
        }
        return residuals.reduce((acc, value) => acc + value * value, 0);
    }

    function residualVectorSummary(residuals) {
        if (!residuals || residuals.length < 2) {
            return {
                count: 0,
                sse: Infinity,
                rms: Infinity,
                meanDx: 0,
                meanDy: 0,
            };
        }
        let sumDx = 0;
        let sumDy = 0;
        let sse = 0;
        const count = residuals.length / 2;
        for (let i = 0; i < residuals.length; i += 2) {
            sumDx += residuals[i];
            sumDy += residuals[i + 1];
            sse += residuals[i] * residuals[i] + residuals[i + 1] * residuals[i + 1];
        }
        return {
            count,
            sse,
            rms: Math.sqrt(sse / count),
            meanDx: sumDx / count,
            meanDy: sumDy / count,
        };
    }

    function recenterFitVectorOnResidualMean(x, residualFn) {
        if (!state.image || x.length < 7) {
            return {x: x.slice(), before: null, after: null, changed: false};
        }
        const startResiduals = residualFn(x);
        const before = residualVectorSummary(startResiduals);
        if (!Number.isFinite(before.sse) || before.count === 0) {
            return {x: x.slice(), before, after: before, changed: false};
        }
        let centered = x.slice();
        for (let pass = 0; pass < 3; pass++) {
            const residuals = residualFn(centered);
            const stats = residualVectorSummary(residuals);
            if (!Number.isFinite(stats.sse) || Math.hypot(stats.meanDx, stats.meanDy) < 1e-4) {
                break;
            }
            const duStep = 1e-6;
            const dvStep = 1e-6;
            const duProbe = centered.slice();
            const dvProbe = centered.slice();
            duProbe[5] += duStep;
            dvProbe[6] += dvStep;
            const duStats = residualVectorSummary(residualFn(duProbe));
            const dvStats = residualVectorSummary(residualFn(dvProbe));
            if (!Number.isFinite(duStats.sse) || !Number.isFinite(dvStats.sse)) {
                break;
            }
            const j00 = (duStats.meanDx - stats.meanDx) / duStep;
            const j10 = (duStats.meanDy - stats.meanDy) / duStep;
            const j01 = (dvStats.meanDx - stats.meanDx) / dvStep;
            const j11 = (dvStats.meanDy - stats.meanDy) / dvStep;
            const det = j00 * j11 - j01 * j10;
            if (Math.abs(det) < 1e-12) {
                break;
            }
            const deltaDu = (-stats.meanDx * j11 + j01 * stats.meanDy) / det;
            const deltaDv = (-j00 * stats.meanDy + stats.meanDx * j10) / det;
            if (!Number.isFinite(deltaDu) || !Number.isFinite(deltaDv)) {
                break;
            }
            centered[5] = centered[5] + deltaDu;
            centered[6] = centered[6] + deltaDv;
            centered = clampFitVectorToBounds(centered, Number(controls.optmod.value) || 2);
            if (fitPenalty(centered, Number(controls.optmod.value) || 2) > 0) {
                centered = x.slice();
                break;
            }
        }
        const after = residualVectorSummary(residualFn(centered));
        if (!Number.isFinite(after.sse) || after.sse > before.sse + 1e-6) {
            return {x: x.slice(), before, after: before, changed: false};
        }
        return {
            x: centered,
            before,
            after,
            changed: Math.abs(centered[5] - x[5]) > 1e-12 || Math.abs(centered[6] - x[6]) > 1e-12,
        };
    }

    function robustResidualScale(residuals) {
        if (!residuals || residuals.length < 2) {
            return 8;
        }
        const radii = [];
        for (let i = 0; i < residuals.length; i += 2) {
            radii.push(Math.hypot(residuals[i], residuals[i + 1]));
        }
        return Math.max(4, 1.4826 * median(radii));
    }

    function robustLoss(residuals) {
        if (!residuals) {
            return 1e12;
        }
        const c = 1.345 * robustResidualScale(residuals);
        let loss = 0;
        for (let i = 0; i < residuals.length; i += 2) {
            const r = Math.hypot(residuals[i], residuals[i + 1]);
            loss += r <= c ? r * r : 2 * c * r - c * c;
        }
        return loss;
    }

    function robustWeightedResiduals(residuals) {
        if (!residuals) {
            return null;
        }
        const c = 1.345 * robustResidualScale(residuals);
        const weighted = residuals.slice();
        for (let i = 0; i < weighted.length; i += 2) {
            const r = Math.hypot(weighted[i], weighted[i + 1]);
            if (r > c && r > 1e-9) {
                const scale = Math.sqrt(c / r);
                weighted[i] *= scale;
                weighted[i + 1] *= scale;
            }
        }
        return weighted;
    }

    function regularizationResiduals(x, optmod = Number(controls.optmod.value) || 2) {
        if (!state.image || optmod !== BROWN_CONRADY_OPTMOD) {
            return [];
        }
        const width = state.image.width;
        const height = state.image.height;
        const residuals = [];
        const f1 = Math.max(Math.abs(x[0]), 1e-6);
        const f2 = Math.max(Math.abs(x[1]), 1e-6);
        const du = x[5] || 0;
        const dv = x[6] || 0;
        const k1 = x[7] || 0;
        const k2 = x[8] || 0;
        const k3 = x[9] || 0;
        const p1 = x[10] || 0;
        const p2 = x[11] || 0;
        const corners = [
            [0, 0],
            [width - 1, 0],
            [0, height - 1],
            [width - 1, height - 1],
        ];
        let cornerRadius = 0.5;
        for (const [px, py] of corners) {
            const xn = (px / width - 0.5 - du) / f1;
            const yn = (py / height - 0.5 - dv) / f2;
            cornerRadius = Math.max(cornerRadius, Math.hypot(xn, yn));
        }
        const maxR = Math.min(2.0, cornerRadius * 1.1);
        for (let i = 1; i <= 8; i++) {
            const r = maxR * i / 8;
            const r2 = r * r;
            const r4 = r2 * r2;
            const r6 = r4 * r2;
            const derivative = 1 + 3 * k1 * r2 + 5 * k2 * r4 + 7 * k3 * r6;
            if (!Number.isFinite(derivative)) {
                residuals.push(2000);
            } else if (derivative < 0.03) {
                residuals.push((0.03 - derivative) * 40);
            }
        }
        residuals.push(k1 * 0.4, k2 * 0.8, k3 * 1.6, p1 * 8, p2 * 8);
        return residuals;
    }

    function regularizationSumSquares(x, optmod = Number(controls.optmod.value) || 2) {
        return residualSumSquares(regularizationResiduals(x, optmod));
    }

    function regularizedResidualFactory(rawResidualFn, optmod = Number(controls.optmod.value) || 2) {
        return x => {
            const raw = rawResidualFn(x);
            if (!raw) {
                return null;
            }
            return raw.concat(regularizationResiduals(x, optmod));
        };
    }

    function matchObjectiveFactory(residualFn = matchResidualFactory(), optmod = Number(controls.optmod.value) || 2) {
        return x => {
            const penalty = fitPenalty(x, optmod);
            if (penalty > 0) {
                return penalty;
            }
            return robustLoss(residualFn(x)) + regularizationSumSquares(x, optmod);
        };
    }

    function leastSquaresObjectiveFactory(residualFn = matchResidualFactory(), optmod = Number(controls.optmod.value) || 2) {
        return x => {
            const penalty = fitPenalty(x, optmod);
            if (penalty > 0) {
                return penalty;
            }
            return residualSumSquares(residualFn(x));
        };
    }

    function nelderMead(objective, start, steps, maxIter, optmod = Number(controls.optmod.value) || 2) {
        const boundedStart = clampFitVectorToBounds(start, optmod);
        const n = boundedStart.length;
        let simplex = [{x: boundedStart.slice(), fx: objective(boundedStart)}];
        for (let i = 0; i < n; i++) {
            const x = boundedStart.slice();
            x[i] += steps[i];
            const bounded = clampFitVectorToBounds(x, optmod);
            simplex.push({x: bounded, fx: objective(bounded)});
        }

        const alpha = 1.0;
        const gamma = 2.0;
        const rho = 0.5;
        const sigma = 0.5;
        let iterations = 0;

        for (; iterations < maxIter; iterations++) {
            simplex.sort((a, b) => a.fx - b.fx);
            const best = simplex[0].fx;
            const spread = simplex.reduce((acc, p) => Math.max(acc, Math.abs(p.fx - best)), 0);
            if (spread < 1e-6) {
                break;
            }

            const centroid = Array(n).fill(0);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    centroid[j] += simplex[i].x[j] / n;
                }
            }

            const worst = simplex[n].x;
            const reflected = clampFitVectorToBounds(
                centroid.map((c, j) => c + alpha * (c - worst[j])),
                optmod
            );
            const fr = objective(reflected);

            if (fr < simplex[0].fx) {
                const expanded = clampFitVectorToBounds(
                    centroid.map((c, j) => c + gamma * (reflected[j] - c)),
                    optmod
                );
                const fe = objective(expanded);
                simplex[n] = fe < fr ? {x: expanded, fx: fe} : {x: reflected, fx: fr};
            } else if (fr < simplex[n - 1].fx) {
                simplex[n] = {x: reflected, fx: fr};
            } else {
                const contracted = clampFitVectorToBounds(
                    centroid.map((c, j) => c + rho * (worst[j] - c)),
                    optmod
                );
                const fc = objective(contracted);
                if (fc < simplex[n].fx) {
                    simplex[n] = {x: contracted, fx: fc};
                } else {
                    for (let i = 1; i <= n; i++) {
                        const x = clampFitVectorToBounds(
                            simplex[0].x.map((v, j) => v + sigma * (simplex[i].x[j] - v)),
                            optmod
                        );
                        simplex[i] = {x, fx: objective(x)};
                    }
                }
            }
        }
        simplex.sort((a, b) => a.fx - b.fx);
        return {x: simplex[0].x, fx: simplex[0].fx, iterations};
    }

    function fitStartCandidates(objective, start, optmod = Number(controls.optmod.value) || 2) {
        const starts = [];
        const seen = new Set();
        const addStart = x => {
            const bounded = clampFitVectorToBounds(x, optmod);
            if (fitPenalty(bounded, optmod) > 0) {
                return;
            }
            const key = bounded.map(value => value.toFixed(5)).join(",");
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            const fx = objective(bounded);
            if (Number.isFinite(fx)) {
                starts.push({x: bounded.slice(), fx});
            }
        };

        addStart(start);
        if (state.lastFitVector && state.lastFitVector.length === start.length) {
            addStart(state.lastFitVector);
        }

        const axisOffsets = optmod === BROWN_CONRADY_OPTMOD
            ? [0.08, 0.08, 3, 3, 8, 0.02, 0.02, 0.04, 0.01, 0.005, 0.002, 0.002]
            : [0.08, 0.08, 3, 3, 8, 0.02, 0.02, 0.08];
        for (let i = 0; i < start.length; i++) {
            for (const sign of [-1, 1]) {
                const x = start.slice();
                x[i] += sign * axisOffsets[i];
                addStart(x);
            }
        }
        addStart([-start[0], start[1], ...start.slice(2)]);
        addStart([start[0], -start[1], ...start.slice(2)]);
        addStart([-start[0], -start[1], ...start.slice(2)]);

        for (let i = 0; i < 120; i++) {
            const f1Factor = Math.exp((Math.random() * 2 - 1) * 0.25);
            const f2Factor = Math.exp((Math.random() * 2 - 1) * 0.25);
            addStart([
                start[0] * f1Factor * (Math.random() < 0.06 ? -1 : 1),
                start[1] * f2Factor * (Math.random() < 0.06 ? -1 : 1),
                start[2] + (Math.random() * 2 - 1) * 12,
                start[3] + (Math.random() * 2 - 1) * 12,
                start[4] + (Math.random() * 2 - 1) * 25,
                start[5] + (Math.random() * 2 - 1) * 0.06,
                start[6] + (Math.random() * 2 - 1) * 0.06,
                start[7] + (Math.random() * 2 - 1) * (optmod === BROWN_CONRADY_OPTMOD ? 0.08 : 0.18),
            ].concat(optmod === BROWN_CONRADY_OPTMOD ? [
                (start[8] || 0) + (Math.random() * 2 - 1) * 0.03,
                (start[9] || 0) + (Math.random() * 2 - 1) * 0.01,
                (start[10] || 0) + (Math.random() * 2 - 1) * 0.004,
                (start[11] || 0) + (Math.random() * 2 - 1) * 0.004,
            ] : []));
        }

        starts.sort((a, b) => a.fx - b.fx);
        return starts.slice(0, Math.min(32, starts.length));
    }

    function solveLinearSystem(a, b) {
        const n = b.length;
        const m = a.map((row, i) => row.slice().concat([b[i]]));
        for (let col = 0; col < n; col++) {
            let pivot = col;
            for (let row = col + 1; row < n; row++) {
                if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) {
                    pivot = row;
                }
            }
            if (Math.abs(m[pivot][col]) < 1e-12) {
                return null;
            }
            if (pivot !== col) {
                const tmp = m[col];
                m[col] = m[pivot];
                m[pivot] = tmp;
            }
            const pivotValue = m[col][col];
            for (let j = col; j <= n; j++) {
                m[col][j] /= pivotValue;
            }
            for (let row = 0; row < n; row++) {
                if (row === col) {
                    continue;
                }
                const factor = m[row][col];
                for (let j = col; j <= n; j++) {
                    m[row][j] -= factor * m[col][j];
                }
            }
        }
        return m.map(row => row[n]);
    }

    function levenbergMarquardt(residualFn, start, maxIter = 80, optmod = Number(controls.optmod.value) || 2) {
        const n = start.length;
        const diffSteps = optmod === BROWN_CONRADY_OPTMOD
            ? [1e-4, 1e-4, 1e-3, 1e-3, 1e-3, 1e-5, 1e-5, 1e-5, 1e-6, 1e-6, 1e-6, 1e-6]
            : [1e-4, 1e-4, 1e-3, 1e-3, 1e-3, 1e-5, 1e-5, 1e-4];
        let x = clampFitVectorToBounds(start, optmod);
        let residuals = residualFn(x);
        let fx = residualSumSquares(residuals);
        let lambda = 1e-3;
        let iterations = 0;
        let accepted = 0;
        for (; iterations < maxIter; iterations++) {
            if (!residuals || !Number.isFinite(fx)) {
                break;
            }
            const m = residuals.length;
            const jac = Array.from({length: m}, () => Array(n).fill(0));
            for (let col = 0; col < n; col++) {
                const h = diffSteps[col];
                const xp = x.slice();
                xp[col] += h;
                const rp = residualFn(xp);
                if (!rp) {
                    continue;
                }
                for (let row = 0; row < m; row++) {
                    jac[row][col] = (rp[row] - residuals[row]) / h;
                }
            }
            const jtj = Array.from({length: n}, () => Array(n).fill(0));
            const jtr = Array(n).fill(0);
            for (let row = 0; row < m; row++) {
                for (let i = 0; i < n; i++) {
                    jtr[i] += jac[row][i] * residuals[row];
                    for (let j = 0; j < n; j++) {
                        jtj[i][j] += jac[row][i] * jac[row][j];
                    }
                }
            }
            let improved = false;
            for (let attempt = 0; attempt < 8; attempt++) {
                const a = jtj.map((row, i) => row.map((value, j) => {
                    if (i !== j) {
                        return value;
                    }
                    return value + lambda * Math.max(1, Math.abs(value));
                }));
                const step = solveLinearSystem(a, jtr.map(value => -value));
                if (!step) {
                    lambda *= 10;
                    continue;
                }
                const xCandidate = clampFitVectorToBounds(x.map((value, i) => value + step[i]), optmod);
                if (fitPenalty(xCandidate, optmod) > 0) {
                    lambda *= 10;
                    continue;
                }
                const candidateResiduals = residualFn(xCandidate);
                const candidateFx = residualSumSquares(candidateResiduals);
                if (candidateResiduals && candidateFx < fx) {
                    x = xCandidate;
                    residuals = candidateResiduals;
                    fx = candidateFx;
                    lambda = Math.max(lambda / 3, 1e-9);
                    accepted += 1;
                    improved = true;
                    if (Math.sqrt(step.reduce((acc, value) => acc + value * value, 0)) < 1e-7) {
                        return {x, fx, iterations: iterations + 1, accepted};
                    }
                    break;
                }
                lambda *= 10;
            }
            if (!improved) {
                break;
            }
        }
        return {x, fx, iterations, accepted};
    }

    function acceptFitResult(result, start, residualFn, methodLabel, detail, fitCount, objectiveLabel, fitScopeText = null) {
        const startSse = residualSumSquares(residualFn(start));
        const recentered = recenterFitVectorOnResidualMean(result.x, residualFn);
        const acceptedVector = recentered.x;
        const resultSse = residualSumSquares(residualFn(acceptedVector));
        const rmsBefore = Math.sqrt(startSse / fitCount);
        const rmsAfter = Math.sqrt(resultSse / fitCount);
        if (!Number.isFinite(rmsAfter) || rmsAfter > Math.max(50, rmsBefore * 1.25)) {
            state.fitMessage = `${methodLabel} rejected: RMS ${rmsBefore.toFixed(2)} -> ${rmsAfter.toFixed(2)} px`;
            render();
            return {
                accepted: false,
                rmsBefore,
                rmsAfter,
                fitCount,
                message: state.fitMessage,
            };
        }
        rememberFitState(methodLabel);
        applyFitVector(acceptedVector);
        state.lastFitVector = acceptedVector.slice();
        state.lastAcceptedFitVector = acceptedVector.slice();
        state.pendingMatch = null;
        state.showPickedMatchMarkers = false;
        const scopeText = fitScopeText || `with mag <= ${Number(controls.maxMag.value).toFixed(1)}`;
        const recenterText = recentered.changed && recentered.before && recentered.after ?
            `; recentered du/dv mean residual ${recentered.before.meanDx.toFixed(2)}/${recentered.before.meanDy.toFixed(2)} -> ` +
            `${recentered.after.meanDx.toFixed(2)}/${recentered.after.meanDy.toFixed(2)} px` :
            "";
        state.fitMessage = `${methodLabel}: RMS ${rmsBefore.toFixed(2)} -> ${rmsAfter.toFixed(2)} px, ` +
            `${detail}; ${objectiveLabel}; fitted all ${result.x.length} optpar values using ${fitCount}/${state.matches.length} pairs ` +
            `${scopeText}${recenterText}`;
        recomputeAndRender();
        return {
            accepted: true,
            rmsBefore,
            rmsAfter,
            fitCount,
            optpar: acceptedVector.slice(),
            message: state.fitMessage,
        };
    }

    function fitLensFromMatches(options = {}) {
        const matchesForFit = Array.isArray(options.matches) ? options.matches : fittingMatches();
        const fitCount = matchesForFit.length;
        const optmod = Number(controls.optmod.value) || 2;
        const minPairs = Math.ceil(requiredOptparLength(optmod) / 2);
        if (!state.image || fitCount < minPairs) {
            state.fitMessage = `lens fit: need at least ${minPairs} matched star pairs with mag <= ` +
                `${Number(controls.maxMag.value).toFixed(1)} (${fitCount}/${state.matches.length} available)`;
            render();
            return {accepted: false, reason: "not enough matched star pairs", fitCount};
        }

        const residualFn = matchResidualFactory(matchesForFit);
        const objective = matchObjectiveFactory(residualFn, optmod);
        const start = currentFitVector();
        const steps = optmod === BROWN_CONRADY_OPTMOD
            ? [0.05, 0.05, 1.5, 1.5, 2.0, 0.006, 0.006, 0.02, 0.006, 0.003, 0.001, 0.001]
            : [0.05, 0.05, 1.5, 1.5, 2.0, 0.006, 0.006, 0.03];
        const starts = fitStartCandidates(objective, start, optmod);
        let result = null;
        let totalIterations = 0;
        for (const candidate of starts) {
            const candidateResult = nelderMead(objective, candidate.x, steps, 800, optmod);
            totalIterations += candidateResult.iterations;
            if (!result || candidateResult.fx < result.fx) {
                result = candidateResult;
            }
        }
        if (!result) {
            state.fitMessage = "lens fit rejected: no valid grid-search start points";
            render();
            return {accepted: false, reason: "no valid grid-search start points", fitCount};
        }
        return acceptFitResult(
            result,
            start,
            residualFn,
            options.methodLabel || "Nelder-Mead lens fit",
            `${starts.length} starts including random perturbations, ${totalIterations} iterations`,
            fitCount,
            optmod === BROWN_CONRADY_OPTMOD ? "Brown-Conrady monotonic robust Huber objective" : "robust Huber objective",
            options.fitScopeText || null
        );
    }

    function fitLensLevenbergMarquardt(options = {}) {
        const matchesForFit = Array.isArray(options.matches) ? options.matches : fittingMatches();
        const fitCount = matchesForFit.length;
        const optmod = Number(controls.optmod.value) || 2;
        const minPairs = Math.ceil(requiredOptparLength(optmod) / 2);
        if (!state.image || fitCount < minPairs) {
            state.fitMessage = `LM lens fit: need at least ${minPairs} matched star pairs with mag <= ` +
                `${Number(controls.maxMag.value).toFixed(1)} (${fitCount}/${state.matches.length} available)`;
            render();
            return {accepted: false, reason: "not enough matched star pairs", fitCount};
        }
        const residualFn = matchResidualFactory(matchesForFit);
        const lmResidualFn = optmod === BROWN_CONRADY_OPTMOD ?
            regularizedResidualFactory(residualFn, optmod) :
            residualFn;
        const objective = leastSquaresObjectiveFactory(lmResidualFn, optmod);
        const start = currentFitVector();
        const starts = fitStartCandidates(objective, start, optmod).slice(0, 12);
        let result = null;
        let totalIterations = 0;
        let accepted = 0;
        for (const candidate of starts) {
            const candidateResult = levenbergMarquardt(lmResidualFn, candidate.x, 80, optmod);
            totalIterations += candidateResult.iterations;
            accepted += candidateResult.accepted;
            if (!result || candidateResult.fx < result.fx) {
                result = candidateResult;
            }
        }
        if (!result) {
            state.fitMessage = "LM lens fit rejected: no valid start points";
            render();
            return {accepted: false, reason: "no valid start points", fitCount};
        }
        return acceptFitResult(
            result,
            start,
            residualFn,
            options.methodLabel || "Levenberg-Marquardt lens fit",
            `${starts.length} starts, ${totalIterations} iterations, ${accepted} accepted steps`,
            fitCount,
            optmod === BROWN_CONRADY_OPTMOD ? "Brown-Conrady monotonic ordinary least-squares objective" : "ordinary least-squares objective",
            options.fitScopeText || null
        );
    }

    function currentFitRmsPx() {
        const fitCount = fittingMatches().length;
        if (!state.image || fitCount === 0) {
            return Infinity;
        }
        const residualFn = matchResidualFactory();
        const residuals = residualFn(currentFitVector());
        if (!residuals) {
            return Infinity;
        }
        return Math.sqrt(residualSumSquares(residuals) / fitCount);
    }

    function sortedLuckyFitMatches() {
        return fittingMatches()
            .slice()
            .sort((a, b) => a.catalog.mag - b.catalog.mag || a.id - b.id);
    }

    function luckyFitSweepCounts(totalMatches, optmod) {
        const minPairs = Math.ceil(requiredOptparLength(optmod) / 2);
        const base = [
            minPairs,
            minPairs + 2,
            8,
            10,
            12,
            16,
            20,
            28,
            40,
            totalMatches,
        ];
        const counts = [];
        for (const count of base) {
            const clipped = Math.min(totalMatches, Math.max(minPairs, count));
            if (clipped <= totalMatches && !counts.includes(clipped)) {
                counts.push(clipped);
            }
        }
        return counts.sort((a, b) => a - b);
    }

    function autoAddedMatch(match) {
        const method = String(match && match.image && match.image.method || "").toLowerCase();
        return method.includes("auto") || match.detectionGeneration !== undefined;
    }

    function pruneLuckyAutoOutliers() {
        const rows = matchResidualRows().filter(row => autoAddedMatch(row.match));
        if (rows.length < 6) {
            return {removed: 0, threshold: Infinity, medianDistance: Infinity};
        }
        const medianDx = median(rows.map(row => row.dx));
        const medianDy = median(rows.map(row => row.dy));
        const modeDistances = rows.map(row => Math.hypot(row.dx - medianDx, row.dy - medianDy));
        const medianDistance = median(modeDistances);
        const mad = median(modeDistances.map(distance => Math.abs(distance - medianDistance)));
        const sigma = Math.max(0.5, 1.4826 * mad);
        const threshold = Math.max(8, medianDistance + 4.5 * sigma);
        const candidates = rows
            .map((row, index) => ({...row, modeDistance: modeDistances[index]}))
            .filter(row => row.modeDistance > threshold && row.r > Math.max(6, threshold * 0.75))
            .sort((a, b) => b.modeDistance - a.modeDistance);
        if (candidates.length === 0) {
            return {removed: 0, threshold, medianDistance};
        }
        const maxRemove = Math.max(1, Math.floor(rows.length * 0.25));
        const removeIds = new Set(candidates.slice(0, maxRemove).map(row => row.match.id));
        state.matches = state.matches.filter(match => !removeIds.has(match.id));
        state.pendingMatch = null;
        state.lastFitVector = null;
        updateAutoMatches();
        return {
            removed: removeIds.size,
            threshold,
            medianDistance,
        };
    }

    function setLuckyMaxMagnitude(maxMag) {
        const clipped = Math.max(2, Math.min(7, maxMag));
        controls.maxMag.value = clipped.toFixed(1);
        if (Object.prototype.hasOwnProperty.call(state.maxMagByMode, state.displayMode)) {
            state.maxMagByMode[state.displayMode] = clipped;
        }
    }

    function seedCurrentModelFromBlindIdentification(result) {
        const angles = result && result.rotation ? cameraAnglesFromRotation(result.rotation) : null;
        if (!angles || !state.image) {
            return false;
        }
        const optmod = Number(controls.optmod.value) || 2;
        const seed = defaultOptparForImage(state.image, optmod);
        const width = state.image.width;
        const height = state.image.height;
        const f1 = Number.isFinite(result.f1) ? Math.max(0.12, Math.min(6.0, Math.abs(result.f1))) : seed[0];
        const signX = result.signX === -1 ? -1 : 1;
        const signY = result.signY === -1 ? -1 : 1;
        seed[0] = signX * f1;
        seed[1] = signY * Math.max(0.12, Math.min(6.0, f1 * width / Math.max(1, height)));
        seed[2] = Math.max(-89.5, Math.min(89.5, angles.alpha));
        seed[3] = Math.max(-89.5, Math.min(89.5, angles.beta));
        seed[4] = angles.gamma;
        if (Number.isFinite(result.du)) {
            seed[5] = Math.max(-0.25, Math.min(0.25, result.du));
        }
        if (Number.isFinite(result.dv)) {
            seed[6] = Math.max(-0.25, Math.min(0.25, result.dv));
        }
        if (optmod !== BROWN_CONRADY_OPTMOD && Number.isFinite(result.radialAlpha)) {
            seed[7] = Math.max(
                optmod === 12 ? -2.5 : 0.05,
                Math.min(optmod === 12 ? 2.5 : 2.5, result.radialAlpha)
            );
        }
        applyFitVector(seed);
        state.lastFitVector = seed.slice();
        updateProjection();
        return true;
    }

    function ensureMaxMagnitudeForMatches(matches) {
        const mags = (matches || [])
            .map(match => Number(match && (match.catalog ? match.catalog.mag : match.star && match.star.mag)))
            .filter(Number.isFinite);
        if (!mags.length) {
            return;
        }
        setLuckyMaxMagnitude(Math.min(7, Math.max(Number(controls.maxMag.value) || 0, Math.max(...mags))));
    }

    async function runLuckyFitStage(stage, stageIndex, totalStages) {
        setLuckyMaxMagnitude(stage.maxMagnitude);
        const pass = await runAutoIdentifyPass({
            label: `I'm feeling lucky ${stageIndex}/${totalStages}`,
            maxDetections: stage.maxDetections,
            maxMagnitude: stage.maxMagnitude,
            detectorOptions: stage.detectorOptions,
            includeBlind: stage.includeBlind,
            includeAsterisms: stage.includeAsterisms,
            includeProjected: true,
            minBlindMatches: stage.minBlindMatches || 6,
            minAsterismMatches: stage.minAsterismMatches || 4,
            minProjectedMatches: stage.minProjectedMatches || 4,
            blindOptions: stage.blindOptions,
            asterismOptions: stage.asterismOptions,
            weakAsterismOptions: stage.weakAsterismOptions,
            projectedOptions: stage.projectedOptions,
            reuseExistingMatchesForTransform: true,
            maxAddDistancePx: stage.maxAddDistancePx,
            maxMedianDistance: stage.maxMedianDistance,
            minAsterismChecksForNewStars: stage.minAsterismChecksForNewStars,
            maxAsterismCheckPartners: stage.maxAsterismCheckPartners,
            newStarAsterismSignatureTolerance: stage.newStarAsterismSignatureTolerance,
            methodLabel: "lucky auto star finder",
        });
        let seeded = false;
        if (stage.seedFromBlind && stage.allowProvisionalBlindPairs === true && pass.result.matches.length >= 4) {
            if (pass.added === 0) {
                const fallbackAdded = addAutoIdentificationMatches(pass.result, "lucky blind bootstrap", {
                    ignoreDistanceGuards: true,
                    maxAdditions: Number.isFinite(stage.bootstrapMaxAdditions) ? stage.bootstrapMaxAdditions : 24,
                });
                if (fallbackAdded > 0) {
                    pass.added += fallbackAdded;
                    state.pendingMatch = null;
                    clearDensityEstimate();
                    state.showPickedMatchMarkers = true;
                    state.lastFitVector = null;
                    ensureMaxMagnitudeForMatches(state.matches);
                    state.automaticMatchingStatus =
                        `${String(pass.result.status || "").replace(/auto-identify/g, "automatic matching")}; ` +
                        `added ${fallbackAdded} provisional blind bootstrap pairing` +
                        `${fallbackAdded === 1 ? "" : "s"} for fitting`;
                    updateAutoMatches();
                    render();
                    await yieldToBrowser();
                }
            }
            seeded = seedCurrentModelFromBlindIdentification(pass.result);
            if (seeded) {
                recomputeAndRender();
                await yieldToBrowser();
            }
        }
        return {...pass, seeded};
    }

    async function runLuckySelectedModelFits(label, options = {}) {
        const optmod = Number(controls.optmod.value) || 2;
        const minPairs = Math.ceil(requiredOptparLength(optmod) / 2);
        const sortedMatches = sortedLuckyFitMatches();
        if (sortedMatches.length < minPairs) {
            return {accepted: 0, skipped: true};
        }
        const counts = options.counts || luckyFitSweepCounts(sortedMatches.length, optmod);
        let accepted = 0;
        let attempted = 0;
        let lastRms = Infinity;
        for (let i = 0; i < counts.length; i += 1) {
            const count = counts[i];
            const subset = sortedMatches.slice(0, count);
            const scope = `from the ${count} brightest bootstrap pairs`;
            const first = i === 0;
            const final = i === counts.length - 1;
            if (first || final || options.robustEachStep === true) {
                setLoadingProgress(
                    86,
                    `${label}: robust fit of selected optmod ${optmod} using ${count} brightest pairs...`
                );
                await yieldToBrowser();
                const nm = fitLensFromMatches({
                    matches: subset,
                    methodLabel: `${label} Nelder-Mead sweep`,
                    fitScopeText: scope,
                });
                accepted += nm && nm.accepted ? 1 : 0;
                attempted += 1;
                await yieldToBrowser();
            }
            setLoadingProgress(
                final ? 92 : 89,
                `${label}: Levenberg-Marquardt sweep of selected optmod ${optmod} using ${count} brightest pairs...`
            );
            await yieldToBrowser();
            const lm = fitLensLevenbergMarquardt({
                matches: subset,
                methodLabel: `${label} LM sweep`,
                fitScopeText: scope,
            });
            accepted += lm && lm.accepted ? 1 : 0;
            attempted += 1;
            if (lm && Number.isFinite(lm.rmsAfter)) {
                lastRms = lm.rmsAfter;
            }
            await yieldToBrowser();
        }
        return {accepted, attempted, skipped: false, counts, lastRms};
    }

    async function feelingLuckyFit() {
        if (!state.image || !state.imagePixels) {
            state.fitMessage = "I'm feeling lucky: load an image with readable pixels first";
            render();
            return;
        }
        if (!autoIdentifierAvailable()) {
            state.fitMessage = "I'm feeling lucky: matcher module is unavailable";
            render();
            return;
        }
        if (state.autoIdentifyBusy || state.luckyFitBusy) {
            return;
        }
        state.luckyFitBusy = true;
        controls.luckyFit.disabled = true;
        controls.fitLens.disabled = true;
        controls.fitLensLm.disabled = true;
        const optmod = Number(controls.optmod.value) || 2;
        const undoSnapshot = autoPairingUndoSnapshot("I'm feeling lucky");
        state.asterismEdges = [];
        state.showAsterismLines = true;
        setTriangleDebugSnapshot(null);
        const removedBadAreaMatches = removeAutomaticMatchesInBadStarFinderRegions();
        const startingMatchCount = state.matches.length;
        const optmod2RadialAlphaGrid = [0.30, 0.50, 0.60, 0.80, 0.90, 1.00];
        const stages = [
            {
                maxDetections: 80,
                maxMagnitude: 6.0,
                phase: "blind bootstrap",
                seedFromBlind: true,
                includeBlind: true,
                includeAsterisms: true,
                detectorOptions: {
                    thresholdSigma: 1.8,
                    localThresholdSigma: 1.8,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                    suppressionRadiusPx: 10,
                    crowdingRadiusPx: 36,
                    maxCrowding: 7,
                    crowdingScorePower: 1.25,
                },
                blindOptions: {
                    maxDetections: 80,
                    enableRegionalDetectionCoverage: true,
                    regionalDetectionCols: 3,
                    regionalDetectionRows: 2,
                    regionalDetectionMinPerRegion: 4,
                    regionalDetectionOverlap: 0.25,
                    maxBlindAsterismsPerRegion: 10,
                    maxBlindVerifyDetections: 80,
                    maxCatalogStars: 220,
                    maxCatalogTriangleStars: 220,
                    maxCatalogTriangles: 30000,
                    preflattenModelCandidates: ["pinhole", "fisheye"],
                    preflattenF1Candidates: [0.70, 0.85, 1.00],
                    preflattenRadialAlphaCandidates: [0.30, 0.60, 0.90],
                    maxCatalogLocalNeighbors: 20,
                    maxBlindNeighborTriangles: 8,
                    blindEarlyAcceptMatches: 12,
                    maxBlindCandidateRotations: 12000,
                    rejectAmbiguousBlindMatches: true,
                    blindAmbiguityRadiusDeg: 1.0,
                    blindAmbiguityDistanceSlackDeg: 0.35,
                    blindPixelAmbiguityRadiusPx: 18,
                    blindPixelAmbiguityDistanceSlackPx: 8,
                    ambiguityMaxMagnitude: 6.0,
                },
                maxAddDistancePx: 0.8,
                maxMedianDistance: 0.42,
                weakAsterismOptions: deepAsterismFallbackStages({
                    summaryLabel: "lucky bright bootstrap",
                }),
            },
            {
                maxDetections: 160,
                maxMagnitude: 4.0,
                phase: "extended blind bright-star bootstrap",
                seedFromBlind: true,
                includeBlind: true,
                includeAsterisms: true,
                runOnlyWithoutSeed: true,
                detectorOptions: {
                    thresholdSigma: 1.8,
                    localThresholdSigma: 1.8,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                    suppressionRadiusPx: 10,
                    crowdingRadiusPx: 36,
                    maxCrowding: 7,
                    crowdingScorePower: 1.25,
                },
                blindOptions: {
                    maxDetections: 160,
                    enableRegionalDetectionCoverage: true,
                    regionalDetectionCols: 3,
                    regionalDetectionRows: 2,
                    regionalDetectionMinPerRegion: 4,
                    regionalDetectionOverlap: 0.25,
                    maxBlindAsterismsPerRegion: 10,
                    maxBlindVerifyDetections: 140,
                    maxCatalogStars: 220,
                    maxCatalogTriangleStars: 220,
                    maxCatalogTriangles: 30000,
                    maxDetectionTriangleStars: 120,
                    maxDetectionTriangles: 6000,
                    preflattenModelCandidates: ["pinhole", "fisheye"],
                    preflattenF1Candidates: [0.70, 0.85, 1.00],
                    preflattenRadialAlphaCandidates: [0.30, 0.60, 0.90],
                    maxCatalogLocalNeighbors: 20,
                    maxBlindNeighborTriangles: 8,
                    blindEarlyAcceptMatches: 12,
                    maxBlindCandidateRotations: 12000,
                    rejectAmbiguousBlindMatches: true,
                    blindAmbiguityRadiusDeg: 1.0,
                    blindAmbiguityDistanceSlackDeg: 0.35,
                    blindPixelAmbiguityRadiusPx: 18,
                    blindPixelAmbiguityDistanceSlackPx: 8,
                    ambiguityMaxMagnitude: 6.0,
                },
                maxAddDistancePx: 0.8,
                maxMedianDistance: 0.42,
                weakAsterismOptions: deepAsterismFallbackStages({
                    summaryLabel: "lucky extended bootstrap",
                }),
            },
            {
                maxDetections: 320,
                maxMagnitude: 6.0,
                phase: "phone deep blind bootstrap",
                seedFromBlind: true,
                includeBlind: true,
                includeAsterisms: true,
                runOnlyWithoutSeed: true,
                detectorOptions: {
                    thresholdSigma: 1.5,
                    localThresholdSigma: 1.5,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                    suppressionRadiusPx: 10,
                    crowdingRadiusPx: 36,
                    maxCrowding: 7,
                    crowdingScorePower: 1.25,
                },
                blindOptions: {
                    maxDetections: 320,
                    enableRegionalDetectionCoverage: true,
                    regionalDetectionCols: 3,
                    regionalDetectionRows: 2,
                    regionalDetectionMinPerRegion: 4,
                    regionalDetectionOverlap: 0.25,
                    maxBlindAsterismsPerRegion: 10,
                    maxBlindVerifyDetections: 220,
                    maxCatalogStars: 420,
                    maxCatalogTriangleStars: 360,
                    maxCatalogTriangles: 50000,
                    maxAmbiguityCatalogStars: 520,
                    maxDetectionTriangleStars: 180,
                    maxDetectionTriangles: 14000,
                    preflattenModelCandidates: ["pinhole", "fisheye"],
                    preflattenF1Candidates: [0.55, 0.65, 0.75, 0.85, 0.95, 1.10],
                    preflattenRadialAlphaCandidates: [0.15, 0.30, 0.45, 0.60, 0.75, 0.90, 0.98],
                    maxCatalogLocalNeighbors: 24,
                    maxBlindNeighborTriangles: 10,
                    blindEarlyAcceptMatches: 11,
                    blindEarlyAcceptMedianDeg: 0.75,
                    maxBlindCandidateRotations: 18000,
                    rejectAmbiguousBlindMatches: true,
                    blindAmbiguityRadiusDeg: 0.9,
                    blindAmbiguityDistanceSlackDeg: 0.3,
                    blindPixelMatchRadiusPx: 58,
                    blindPixelAmbiguityRadiusPx: 16,
                    blindPixelAmbiguityDistanceSlackPx: 8,
                    ambiguityMaxMagnitude: 7.0,
                },
                maxAddDistancePx: 1.2,
                maxMedianDistance: 0.42,
            },
            {
                maxDetections: 90,
                maxMagnitude: 5.0,
                phase: "projected refinement",
                includeBlind: false,
                includeAsterisms: false,
                detectorOptions: {
                    thresholdSigma: 3.6,
                    localThresholdSigma: 3.4,
                    requireGlobalThreshold: true,
                    maxElongation: 3.0,
                },
                projectedOptions: {
                    maxDetections: 90,
                    maxCatalogStars: 130,
                    maxDistancePx: 34,
                    translationSearchRadiusPx: 90,
                    rejectAmbiguousMatches: true,
                    ambiguityRadiusPx: 18,
                    ambiguityDistanceSlackPx: 16,
                },
                maxAddDistancePx: 8,
                minAsterismChecksForNewStars: 1,
            },
            {
                maxDetections: 180,
                maxMagnitude: 6.5,
                phase: "deeper projected refinement",
                includeBlind: false,
                includeAsterisms: false,
                detectorOptions: {
                    thresholdSigma: 2.7,
                    localThresholdSigma: 2.9,
                    requireGlobalThreshold: false,
                    maxElongation: 3.1,
                    suppressionRadiusPx: 8,
                    crowdingRadiusPx: 30,
                    maxCrowding: 8,
                    crowdingScorePower: 1.15,
                },
                projectedOptions: {
                    maxDetections: 180,
                    maxCatalogStars: 260,
                    maxDistancePx: 18,
                    translationSearchRadiusPx: 35,
                    minMatches: 8,
                    rejectAmbiguousMatches: true,
                    ambiguityRadiusPx: 14,
                    ambiguityDistanceSlackPx: 10,
                },
                maxAddDistancePx: 5,
                maxMedianDistance: 10,
                rejectIfRmsIncreasePx: 0.8,
                minAsterismChecksForNewStars: 2,
            },
            {
                maxDetections: 260,
                maxMagnitude: 7.0,
                phase: "final model-guided expansion",
                includeBlind: false,
                includeAsterisms: false,
                detectorOptions: {
                    thresholdSigma: 2.35,
                    localThresholdSigma: 2.7,
                    requireGlobalThreshold: false,
                    maxElongation: 3.2,
                    suppressionRadiusPx: 8,
                    crowdingRadiusPx: 30,
                    maxCrowding: 8,
                    crowdingScorePower: 1.15,
                },
                projectedOptions: {
                    maxDetections: 260,
                    maxCatalogStars: 420,
                    maxDistancePx: 14,
                    translationSearchRadiusPx: 24,
                    minMatches: 10,
                    rejectAmbiguousMatches: true,
                    ambiguityRadiusPx: 12,
                    ambiguityDistanceSlackPx: 8,
                },
                maxAddDistancePx: 4,
                maxMedianDistance: 8,
                rejectIfRmsIncreasePx: 0.5,
                minAsterismChecksForNewStars: 2,
                skipFit: true,
            },
        ];

        if (optmod === 2) {
            const v010AllskyPreflatten = {
                preflattenF1Candidates: [0.80, 0.70, 0.90, 1.00, 0.60],
                preflattenRadialAlphaCandidates: optmod2RadialAlphaGrid,
            };
            Object.assign(stages[0], {
                maxDetections: 50,
                maxMagnitude: 4.0,
                detectorOptions: {
                    thresholdSigma: 2.2,
                    localThresholdSigma: 2.2,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                },
                blindOptions: {
                    maxDetections: 50,
                    maxCatalogStars: 220,
                    maxCatalogTriangleStars: 220,
                    maxCatalogTriangles: 30000,
                    preflattenModelCandidates: ["fisheye"],
                    ...v010AllskyPreflatten,
                    maxCatalogLocalNeighbors: 20,
                    maxBlindNeighborTriangles: 8,
                    blindEarlyAcceptMatches: 12,
                    maxBlindCandidateRotations: 12000,
                    rejectAmbiguousBlindMatches: true,
                    blindAmbiguityRadiusDeg: 1.0,
                    blindAmbiguityDistanceSlackDeg: 0.35,
                    blindPixelAmbiguityRadiusPx: 18,
                    blindPixelAmbiguityDistanceSlackPx: 8,
                    ambiguityMaxMagnitude: 6.0,
                },
                weakAsterismOptions: null,
            });
            Object.assign(stages[1], {
                maxDetections: 100,
                maxMagnitude: 4.0,
                detectorOptions: {
                    thresholdSigma: 2.2,
                    localThresholdSigma: 2.2,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                },
                blindOptions: {
                    maxDetections: 100,
                    maxBlindVerifyDetections: 100,
                    maxCatalogStars: 220,
                    maxCatalogTriangleStars: 220,
                    maxCatalogTriangles: 30000,
                    maxDetectionTriangleStars: 80,
                    maxDetectionTriangles: 2800,
                    preflattenModelCandidates: ["pinhole", "fisheye"],
                    ...v010AllskyPreflatten,
                    maxCatalogLocalNeighbors: 20,
                    maxBlindNeighborTriangles: 8,
                    blindEarlyAcceptMatches: 12,
                    maxBlindCandidateRotations: 12000,
                    rejectAmbiguousBlindMatches: true,
                    blindAmbiguityRadiusDeg: 1.0,
                    blindAmbiguityDistanceSlackDeg: 0.35,
                    blindPixelAmbiguityRadiusPx: 18,
                    blindPixelAmbiguityDistanceSlackPx: 8,
                    ambiguityMaxMagnitude: 6.0,
                },
                weakAsterismOptions: null,
            });
            Object.assign(stages[2], {
                maxDetections: 140,
                maxMagnitude: 6.0,
                detectorOptions: {
                    thresholdSigma: 1.8,
                    localThresholdSigma: 1.8,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                },
                blindOptions: {
                    maxDetections: 140,
                    maxBlindVerifyDetections: 140,
                    maxCatalogStars: 420,
                    maxCatalogTriangleStars: 360,
                    maxCatalogTriangles: 50000,
                    maxAmbiguityCatalogStars: 520,
                    maxDetectionTriangleStars: 100,
                    maxDetectionTriangles: 5200,
                    preflattenModelCandidates: ["pinhole", "fisheye"],
                    preflattenF1Candidates: [0.55, 0.65, 0.75, 0.85, 0.95, 1.10],
                    preflattenRadialAlphaCandidates: optmod2RadialAlphaGrid,
                    maxCatalogLocalNeighbors: 24,
                    maxBlindNeighborTriangles: 10,
                    blindEarlyAcceptMatches: 11,
                    blindEarlyAcceptMedianDeg: 0.75,
                    maxBlindCandidateRotations: 18000,
                    rejectAmbiguousBlindMatches: true,
                    blindAmbiguityRadiusDeg: 0.9,
                    blindAmbiguityDistanceSlackDeg: 0.3,
                    blindPixelMatchRadiusPx: 58,
                    blindPixelAmbiguityRadiusPx: 16,
                    blindPixelAmbiguityDistanceSlackPx: 8,
                    ambiguityMaxMagnitude: 7.0,
                },
            });
            Object.assign(stages[3], {
                maxDetections: 90,
                maxMagnitude: 5.0,
                detectorOptions: {
                    thresholdSigma: 3.6,
                    localThresholdSigma: 3.4,
                    requireGlobalThreshold: true,
                    maxElongation: 3.0,
                },
                projectedOptions: {
                    maxDetections: 90,
                    maxCatalogStars: 130,
                    maxDistancePx: 34,
                    translationSearchRadiusPx: 90,
                    rejectAmbiguousMatches: true,
                    ambiguityRadiusPx: 18,
                    ambiguityDistanceSlackPx: 16,
                },
                maxAddDistancePx: 8,
                minAsterismChecksForNewStars: 1,
            });
            Object.assign(stages[4], {
                maxDetections: 120,
                maxMagnitude: 6.0,
                detectorOptions: {
                    thresholdSigma: 3.1,
                    localThresholdSigma: 3.2,
                    requireGlobalThreshold: false,
                    maxElongation: 3.1,
                },
                projectedOptions: {
                    maxDetections: 120,
                    maxCatalogStars: 180,
                    maxDistancePx: 24,
                    translationSearchRadiusPx: 55,
                    rejectAmbiguousMatches: true,
                    ambiguityRadiusPx: 18,
                    ambiguityDistanceSlackPx: 16,
                },
                maxAddDistancePx: 8,
                minAsterismChecksForNewStars: 2,
            });
            Object.assign(stages[5], {
                maxDetections: 150,
                maxMagnitude: 6.5,
                detectorOptions: {
                    thresholdSigma: 2.9,
                    localThresholdSigma: 3.0,
                    requireGlobalThreshold: false,
                    maxElongation: 3.2,
                },
                projectedOptions: {
                    maxDetections: 150,
                    maxCatalogStars: 220,
                    maxDistancePx: 18,
                    translationSearchRadiusPx: 35,
                    minMatches: 6,
                    rejectAmbiguousMatches: true,
                    ambiguityRadiusPx: 18,
                    ambiguityDistanceSlackPx: 16,
                },
                maxAddDistancePx: 6,
                minAsterismChecksForNewStars: 2,
                skipFit: false,
            });
            delete stages[4].rejectIfRmsIncreasePx;
            delete stages[5].rejectIfRmsIncreasePx;
            delete stages[5].maxMedianDistance;
        } else if (optmod === BROWN_CONRADY_OPTMOD) {
            const legacyPhonePreflatten = {
                preflattenModelCandidates: ["pinhole", "fisheye"],
                preflattenF1Candidates: [0.70, 0.85, 1.00],
                preflattenRadialAlphaCandidates: [0.30, 0.60, 0.90],
                preflattenDu: 0,
                preflattenDv: 0,
                minBlindMatchSpanXFraction: 0.42,
                minBlindMatchSpanYFraction: 0.34,
            };
            const legacyPhoneDeepPreflatten = {
                preflattenModelCandidates: ["pinhole", "fisheye"],
                preflattenF1Candidates: [0.55, 0.65, 0.75, 0.85, 0.95, 1.10],
                preflattenRadialAlphaCandidates: [0.15, 0.30, 0.45, 0.60, 0.75, 0.90, 0.98],
                preflattenDu: 0,
                preflattenDv: 0,
                minBlindMatchSpanXFraction: 0.42,
                minBlindMatchSpanYFraction: 0.34,
            };
            const imageDirectionDeg = Number(state.currentImageMetadata && state.currentImageMetadata.imageDirectionDeg);
            const iPhoneHeadingGuard = Number.isFinite(imageDirectionDeg) ? {
                expectedBoresightAzDeg: imageDirectionDeg,
                boresightAzToleranceDeg: 60,
                minBoresightElevationDeg: 0,
            } : {};
            Object.assign(legacyPhonePreflatten, iPhoneHeadingGuard);
            Object.assign(legacyPhoneDeepPreflatten, iPhoneHeadingGuard);
            const brownConradyMaxRmsToContinuePx = 12.0;
            Object.assign(stages[0], {
                maxDetections: 80,
                maxMagnitude: 4.0,
                phase: "Brown-Conrady v0.2.0-style blind bootstrap",
                detectorOptions: {
                    scanStep: 1,
                    thresholdSigma: 1.8,
                    localThresholdSigma: 1.8,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                    suppressionRadiusPx: 10,
                    crowdingRadiusPx: 36,
                    maxCrowding: 7,
                    crowdingScorePower: 1.25,
                },
                blindOptions: {
                    maxDetections: 80,
                    maxBlindVerifyDetections: 80,
                    maxCatalogStars: 220,
                    maxCatalogTriangleStars: 220,
                    maxCatalogTriangles: 30000,
                    ...legacyPhonePreflatten,
                    maxCatalogLocalNeighbors: 20,
                    maxBlindNeighborTriangles: 8,
                    blindEarlyAcceptMatches: 12,
                    maxBlindCandidateRotations: 12000,
                    rejectAmbiguousBlindMatches: true,
                    blindAmbiguityRadiusDeg: 1.0,
                    blindAmbiguityDistanceSlackDeg: 0.35,
                    blindPixelMatchRadiusPx: 64,
                    blindPixelAmbiguityRadiusPx: 18,
                    blindPixelAmbiguityDistanceSlackPx: 8,
                    ambiguityMaxMagnitude: 6.0,
                },
                maxAddDistancePx: 0.8,
                maxMedianDistance: 0.42,
                maxRmsToContinuePx: brownConradyMaxRmsToContinuePx,
                weakAsterismOptions: deepAsterismFallbackStages({
                    summaryLabel: "Brown-Conrady v0.2.0-style bootstrap",
                }),
            });
            Object.assign(stages[1], {
                maxDetections: 160,
                maxMagnitude: 4.0,
                phase: "Brown-Conrady v0.2.0-style extended bootstrap",
                detectorOptions: {
                    scanStep: 1,
                    thresholdSigma: 1.8,
                    localThresholdSigma: 1.8,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                    suppressionRadiusPx: 10,
                    crowdingRadiusPx: 36,
                    maxCrowding: 7,
                    crowdingScorePower: 1.25,
                },
                blindOptions: {
                    maxDetections: 160,
                    maxBlindVerifyDetections: 140,
                    maxCatalogStars: 220,
                    maxCatalogTriangleStars: 220,
                    maxCatalogTriangles: 30000,
                    maxDetectionTriangleStars: 120,
                    maxDetectionTriangles: 6000,
                    ...legacyPhonePreflatten,
                    maxCatalogLocalNeighbors: 20,
                    maxBlindNeighborTriangles: 8,
                    blindEarlyAcceptMatches: 12,
                    maxBlindCandidateRotations: 12000,
                    rejectAmbiguousBlindMatches: true,
                    blindAmbiguityRadiusDeg: 1.0,
                    blindAmbiguityDistanceSlackDeg: 0.35,
                    blindPixelAmbiguityRadiusPx: 18,
                    blindPixelAmbiguityDistanceSlackPx: 8,
                    ambiguityMaxMagnitude: 6.0,
                },
                maxAddDistancePx: 0.8,
                maxMedianDistance: 0.42,
                maxRmsToContinuePx: brownConradyMaxRmsToContinuePx,
                weakAsterismOptions: deepAsterismFallbackStages({
                    summaryLabel: "Brown-Conrady v0.2.0-style extended bootstrap",
                }),
            });
            Object.assign(stages[2], {
                maxDetections: 650,
                maxMagnitude: 6.5,
                phase: "Brown-Conrady v0.2.0-style phone deep bootstrap",
                detectorOptions: {
                    scanStep: 1,
                    thresholdSigma: 1.5,
                    localThresholdSigma: 1.5,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                    suppressionRadiusPx: 10,
                    crowdingRadiusPx: 36,
                    maxCrowding: 7,
                    crowdingScorePower: 1.25,
                },
                blindOptions: {
                    maxDetections: 650,
                    maxBlindVerifyDetections: 650,
                    maxCatalogStars: 650,
                    maxCatalogTriangleStars: 420,
                    maxCatalogTriangles: 50000,
                    maxAmbiguityCatalogStars: 700,
                    maxDetectionTriangleStars: 260,
                    maxDetectionTriangles: 20000,
                    ...legacyPhoneDeepPreflatten,
                    maxCatalogLocalNeighbors: 24,
                    maxBlindNeighborTriangles: 10,
                    blindEarlyAcceptMatches: 11,
                    blindEarlyAcceptMedianDeg: 0.75,
                    maxBlindCandidateRotations: 26000,
                    rejectAmbiguousBlindMatches: true,
                    blindAmbiguityRadiusDeg: 0.9,
                    blindAmbiguityDistanceSlackDeg: 0.3,
                    blindPixelMatchRadiusPx: 58,
                    blindPixelAmbiguityRadiusPx: 16,
                    blindPixelAmbiguityDistanceSlackPx: 8,
                    ambiguityMaxMagnitude: 7.0,
                },
                maxAddDistancePx: 1.2,
                maxMedianDistance: 0.42,
                maxRmsToContinuePx: brownConradyMaxRmsToContinuePx,
            });
            Object.assign(stages[3], {
                maxDetections: 90,
                maxMagnitude: 5.0,
                includeAsterisms: false,
                detectorOptions: {
                    thresholdSigma: 3.6,
                    localThresholdSigma: 3.4,
                    requireGlobalThreshold: true,
                    maxElongation: 3.1,
                },
                projectedOptions: {
                    maxDetections: 90,
                    maxCatalogStars: 130,
                    maxDistancePx: 34,
                    translationSearchRadiusPx: 90,
                    rejectAmbiguousMatches: true,
                    ambiguityRadiusPx: 18,
                    ambiguityDistanceSlackPx: 16,
                },
                maxAddDistancePx: 8,
                maxRmsToContinuePx: brownConradyMaxRmsToContinuePx,
                minAsterismChecksForNewStars: 1,
            });
            Object.assign(stages[4], {
                maxDetections: 650,
                maxMagnitude: 6.5,
                detectorOptions: {
                    scanStep: 1,
                    thresholdSigma: 1.5,
                    localThresholdSigma: 1.5,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                    suppressionRadiusPx: 10,
                    crowdingRadiusPx: 36,
                    maxCrowding: 7,
                    crowdingScorePower: 1.25,
                },
                projectedOptions: {
                    maxDetections: 650,
                    maxCatalogStars: 650,
                    maxDistancePx: 18,
                    translationSearchRadiusPx: 35,
                    minMatches: 8,
                    rejectAmbiguousMatches: true,
                    ambiguityRadiusPx: 14,
                    ambiguityDistanceSlackPx: 10,
                },
                maxAddDistancePx: 5,
                maxMedianDistance: 10,
                rejectIfRmsIncreasePx: 0.8,
                maxRmsToContinuePx: brownConradyMaxRmsToContinuePx,
                minAsterismChecksForNewStars: 2,
            });
            Object.assign(stages[5], {
                maxDetections: 650,
                maxMagnitude: 7.0,
                detectorOptions: {
                    scanStep: 1,
                    thresholdSigma: 1.5,
                    localThresholdSigma: 1.5,
                    requireGlobalThreshold: false,
                    maxRadiusPx: 5,
                    maxElongation: 4.0,
                    suppressionRadiusPx: 10,
                    crowdingRadiusPx: 36,
                    maxCrowding: 7,
                    crowdingScorePower: 1.25,
                },
                projectedOptions: {
                    maxDetections: 650,
                    maxCatalogStars: 700,
                    maxDistancePx: 14,
                    translationSearchRadiusPx: 24,
                    minMatches: 10,
                    rejectAmbiguousMatches: true,
                    ambiguityRadiusPx: 12,
                    ambiguityDistanceSlackPx: 8,
                },
                maxAddDistancePx: 4,
                maxMedianDistance: 8,
                rejectIfRmsIncreasePx: 0.5,
                maxRmsToContinuePx: brownConradyMaxRmsToContinuePx,
                minAsterismChecksForNewStars: 2,
                skipFit: true,
            });
        }

        let totalAdded = 0;
        let totalPruned = 0;
        let rejectedExpansionStars = 0;
        let acceptedFits = 0;
        let stagesRun = 0;
        let seeded = false;
        let stoppedAfterEmptyFirstStage = false;
        let stoppedAfterPoorBrownConradyFit = false;
        let poorBrownConradyFitText = "";
        try {
            for (let i = 0; i < stages.length; i += 1) {
                if (stages[i].runOnlyWithoutSeed === true && totalAdded > 0) {
                    continue;
                }
                const stageSnapshot = autoPairingUndoSnapshot(stages[i].phase || `stage ${i + 1}`);
                const rmsBeforeStage = currentFitRmsPx();
                const pass = await runLuckyFitStage(stages[i], i + 1, stages.length);
                stagesRun += 1;
                totalAdded += pass.added;
                seeded = seeded || pass.seeded;
                acceptedFits += pass.fitAccepted ? 1 : 0;
                if (i === 0 && (!pass.result || !Array.isArray(pass.result.matches) || pass.result.matches.length === 0)) {
                    stoppedAfterEmptyFirstStage = true;
                    setLoadingProgress(
                        94,
                        "I'm feeling lucky: first asterism stage found no matched stars; stopping before weaker-star stages."
                    );
                    await yieldToBrowser();
                    break;
                }
                const fitResult = stages[i].skipFit === true ?
                    {accepted: 0, skipped: true} :
                    await runLuckySelectedModelFits(
                        `I'm feeling lucky ${i + 1}/${stages.length} ${stages[i].phase || "fit sweep"}`
                    );
                acceptedFits += fitResult.accepted;
                if (!fitResult.skipped) {
                    const prune = pruneLuckyAutoOutliers();
                    totalPruned += prune.removed;
                    if (prune.removed > 0) {
                        setLoadingProgress(
                            94,
                            `I'm feeling lucky ${i + 1}/${stages.length}: pruned ${prune.removed} automatic outlier${prune.removed === 1 ? "" : "s"} and refitting...`
                        );
                        await yieldToBrowser();
                        const refit = await runLuckySelectedModelFits(
                            `I'm feeling lucky ${i + 1}/${stages.length} after outlier pruning`
                        );
                        acceptedFits += refit.accepted;
                    }
                }
                const rmsAfterStage = currentFitRmsPx();
                if (pass.added > 0 && Number.isFinite(stages[i].rejectIfRmsIncreasePx) &&
                        Number.isFinite(rmsBeforeStage) && Number.isFinite(rmsAfterStage) &&
                        rmsAfterStage - rmsBeforeStage > stages[i].rejectIfRmsIncreasePx) {
                    rejectedExpansionStars += pass.added;
                    totalAdded -= pass.added;
                    restoreStateSnapshot(stageSnapshot);
                    updateProjection();
                    render();
                    continue;
                }
                if (optmod === BROWN_CONRADY_OPTMOD &&
                        Number.isFinite(stages[i].maxRmsToContinuePx) &&
                        (fitResult.skipped || !Number.isFinite(rmsAfterStage) ||
                            rmsAfterStage > stages[i].maxRmsToContinuePx)) {
                    stoppedAfterPoorBrownConradyFit = true;
                    const rmsText = Number.isFinite(rmsAfterStage) ? `${rmsAfterStage.toFixed(2)} px` : "not finite";
                    poorBrownConradyFitText =
                        `stopped after ${i + 1}/${stages.length}: Brown-Conrady RMS ${rmsText} ` +
                        `is above ${stages[i].maxRmsToContinuePx.toFixed(1)} px`;
                    setLoadingProgress(94, `I'm feeling lucky: ${poorBrownConradyFitText}; skipping slower refinement stages.`);
                    await yieldToBrowser();
                    break;
                }
                const improved = Number.isFinite(rmsBeforeStage) && Number.isFinite(rmsAfterStage) ?
                    rmsBeforeStage - rmsAfterStage > 0.15 :
                    fitResult.accepted > 0;
                if (i >= 2 && pass.added === 0 && !improved) {
                    break;
                }
            }
            const fitCount = fittingMatches().length;
            const rms = currentFitRmsPx();
            if (totalAdded > 0 || totalPruned > 0 || removedBadAreaMatches > 0 || acceptedFits > 0) {
                rememberUndoState(undoSnapshot);
            }
            const modelName = optmod === BROWN_CONRADY_OPTMOD ? "Brown-Conrady" : `optmod ${optmod}`;
            const summary = Number.isFinite(rms)
                ? `final RMS ${rms.toFixed(2)} px using ${fitCount}/${state.matches.length} pairs`
                : `only ${fitCount}/${state.matches.length} usable pairs`;
            const stopText = stoppedAfterEmptyFirstStage ?
                "stopped after empty first asterism stage; " :
                stoppedAfterPoorBrownConradyFit ?
                    `${poorBrownConradyFitText}; ` :
                "";
            state.automaticMatchingStatus =
                `I'm feeling lucky: added ${totalAdded} pairings in ${stagesRun} staged bootstrap/refinement passes; ` +
                stopText +
                `${seeded ? "seeded from blind asterisms" : "no blind seed"}; ` +
                `removed ${removedBadAreaMatches} bad-area automatic match${removedBadAreaMatches === 1 ? "" : "es"}; ` +
                `rejected ${rejectedExpansionStars} RMSE-worsening expansion match${rejectedExpansionStars === 1 ? "" : "es"}; ` +
                `pruned ${totalPruned} automatic outlier${totalPruned === 1 ? "" : "s"}; ${acceptedFits} accepted fits`;
            state.fitMessage =
                `I'm feeling lucky: ${modelName}, ${summary}; ` +
                stopText +
                `${totalAdded} new pairings (${startingMatchCount} -> ${state.matches.length}), ` +
                `${rejectedExpansionStars} rejected by RMSE guard, ` +
                `${totalPruned} pruned, ` +
                `${acceptedFits} accepted fit step${acceptedFits === 1 ? "" : "s"}; undo is available`;
            state.asterismEdges = [];
            state.triangleDebugSnapshot = null;
            state.showAsterismLines = false;
            state.showAutoDetectionMarkers = false;
            playInteractionSound(acceptedFits > 0 ? "fit" : "click");
            recomputeAndRender();
        } catch (error) {
            state.fitMessage = `I'm feeling lucky failed: ${error.message || error}`;
            render();
        } finally {
            hideLoadingProgress();
            controls.luckyFit.disabled = false;
            controls.fitLens.disabled = false;
            controls.fitLensLm.disabled = false;
            state.luckyFitBusy = false;
        }
    }

    function isAutomaticStarFinderMatch(match) {
        const method = String(match && match.image && match.image.method || "");
        return /auto star finder|lucky auto/i.test(method);
    }

    function removeAutomaticMatchesInBadStarFinderRegions() {
        if (!state.junkStarFinderRegions.length || !state.matches.length) {
            return 0;
        }
        const before = state.matches.length;
        state.matches = state.matches.filter(match =>
            !isAutomaticStarFinderMatch(match) ||
            !isJunkStarFinderPixel(match.image.x, match.image.y)
        );
        if (state.matches.length !== before) {
            state.matches.forEach((match, index) => {
                match.id = index + 1;
            });
            state.lastFitVector = null;
            updateAutoMatches();
        }
        return before - state.matches.length;
    }

    function clearIdentifiedStars() {
        const count = state.matches.length;
        state.matches = [];
        state.asterismEdges = [];
        state.triangleDebugSnapshot = null;
        state.pendingMatch = null;
        state.lastFitVector = null;
        clearFitUndoStack();
        state.showPickedMatchMarkers = true;
        updateAutoMatches();
        state.fitMessage = count > 0
            ? `removed ${count} star pairing${count === 1 ? "" : "s"}`
            : "no star pairings to remove";
        render();
    }

    function updateFitResidualButton() {
        controls.toggleFitResiduals.textContent =
            state.showFitResiduals ? "Hide fit residual view (R)" : "Show fit residual view (R)";
        controls.toggleFitResiduals.classList.toggle("toggle-on", state.showFitResiduals);
    }

    function toggleFitResiduals() {
        state.showFitResiduals = !state.showFitResiduals;
        updateFitResidualButton();
        render();
    }

    function toggleAsterismLines() {
        state.showAsterismLines = !state.showAsterismLines;
        state.fitMessage = state.showAsterismLines ?
            `asterism lines visible (${state.asterismEdges.length} edges)` :
            "asterism lines hidden";
        render();
    }

    function refreshDisplayImage() {
        state.displayPixels = null;
        state.highPassCacheKey = "";
        uploadImagePixelsToTexture();
        render();
    }

    function resetInteractiveState() {
        state.matches = [];
        state.asterismEdges = [];
        state.triangleDebugSnapshot = null;
        state.pendingMatch = null;
        state.showPickedMatchMarkers = true;
        state.lastFitVector = null;
        state.lastAcceptedFitVector = null;
        state.automaticMatchingStatus = "automatic matching: not run";
        state.fitMessage = "lens fit: not run";
    }

    function resetForNewImage() {
        resetInteractiveState();
        clearFitUndoStack();
        clearDensityEstimate();
        hideZoomCanvas();
        hideLoadingProgress();
        state.baseOptpar = null;
        state.loadedTestCaseId = "";
        state.flipX = false;
        state.flipY = false;
        state.imageFlipX = false;
        state.imageFlipY = false;
        state.displayMode = "pairing";
        state.previousAnnotatedDisplayMode = "pairing";
        state.maxMagByMode = {stellarium: 6.0, pairing: 4.0, pureImage: 6.0, pureStellarium: 6.0};
        state.starNamesByMode = {stellarium: false, pairing: true};
        state.showRaDecGrid = false;
        state.showAzElGrid = true;
        state.showStarNames = true;
        state.dragging = false;
        state.lensDragMode = "none";
        state.lastMouse = [0, 0];
        state.projected = [];
        state.starMatchMode = false;
        state.deleteDetectionMode = false;
        state.maskMode = false;
        state.zoomMode = false;
        state.maskRegions = [];
        state.junkStarFinderRegions = [];
        state.badStarFinderDetections = [];
        state.notStarTiles = [];
        state.notStarTileKeys = new Set();
        state.notStarTilePreview = null;
        state.notStarTilePaintActive = false;
        state.lastNotStarTilePaintPoint = null;
        state.junkStarFinderPreview = null;
        state.junkStarFinderPaintActive = false;
        state.lastJunkStarFinderPoint = null;
        state.detectedStars = [];
        state.currentImageMetadata = null;
        state.deletedDetectionIds = new Set();
        state.autoMatches = [];
        state.asterismEdges = [];
        state.triangleDebugSnapshot = null;
        state.detectorCache = null;
        state.detectorStatus = "detector: no image";
        state.detectionGeneration += 1;
        state.autoIdentifyBusy = false;
        state.luckyFitBusy = false;
        state.centroidPreview = null;
        state.centroidDensity = null;
        state.showKdePositionDots = false;
        state.showFitResiduals = false;
        state.showAsterismLines = true;
        state.lastLensEquation = "";
        controls.optmod.value = "2";
        controls.luckyFit.disabled = false;
        controls.fitLens.disabled = false;
        controls.fitLensLm.disabled = false;
        if (controls.submitTestCase) {
            controls.submitTestCase.disabled = false;
        }
        if (controls.loadTestCase) {
            controls.loadTestCase.disabled = false;
        }
        controls.highPassImage.checked = true;
        controls.highPassWidth.value = "100";
        controls.maxMag.value = "4";
        controls.flipX.classList.remove("toggle-on");
        controls.flipY.classList.remove("toggle-on");
        controls.flipImageX.classList.remove("toggle-on");
        controls.flipImageY.classList.remove("toggle-on");
        controls.toggleRaDecGrid.textContent = "Show RA/Dec grid";
        controls.toggleAzElGrid.textContent = "Hide az/el grid";
        controls.toggleAzElGrid.classList.toggle("toggle-on", true);
        controls.toggleStarNames.textContent = "Hide star names (N)";
        controls.toggleStarNames.classList.toggle("toggle-on", true);
        updateDetectionCircleButton();
        updateFitResidualButton();
    }

    function metadataLooksLikeIphone(exifMetadata) {
        if (!exifMetadata) {
            return false;
        }
        const make = String(exifMetadata.cameraMake || "");
        const model = String(exifMetadata.cameraModel || "");
        return /apple/i.test(make) && /iphone/i.test(model) || /iphone/i.test(`${make} ${model}`);
    }

    function applyImageMetadata(name, exifMetadata = null) {
        const guessed = AidaTools.guessTimestampFromAllsky7Name(name);
        if (guessed) {
            controls.timestampUtc.value = AidaTools.dateToDatetimeLocal(guessed);
        }
        const station = AidaTools.guessAllsky7StationMetadata(name);
        if (station) {
            controls.latDeg.value = station.latDeg.toFixed(6);
            controls.lonDeg.value = station.lonDeg.toFixed(6);
        }
        if (!exifMetadata) {
            return [];
        }
        const applied = [];
        if (exifMetadata.timestampUtc instanceof Date && !Number.isNaN(exifMetadata.timestampUtc.getTime())) {
            controls.timestampUtc.value = AidaTools.dateToDatetimeLocal(exifMetadata.timestampUtc);
            applied.push("time");
        }
        if (Number.isFinite(exifMetadata.latDeg) && Number.isFinite(exifMetadata.lonDeg)) {
            controls.latDeg.value = exifMetadata.latDeg.toFixed(6);
            controls.lonDeg.value = exifMetadata.lonDeg.toFixed(6);
            applied.push("position");
        }
        if (Number.isFinite(exifMetadata.altM)) {
            controls.altM.value = exifMetadata.altM.toFixed(1);
            applied.push("altitude");
        }
        if (Number.isFinite(exifMetadata.imageDirectionDeg)) {
            applied.push(`image direction ${exifMetadata.imageDirectionDeg.toFixed(1)} deg`);
        }
        return applied;
    }

    function loadImageSource(url, name, onLoaded = null, revokeWhenLoaded = false, exifMetadata = null, metadataName = name) {
        const loadId = ++state.imageLoadId;
        const img = new Image();
        setLoadingProgress(8, `Loading ${name}...`);
        img.onload = () => {
            if (loadId !== state.imageLoadId) {
                if (revokeWhenLoaded) {
                    URL.revokeObjectURL(url);
                }
                return;
            }
            setLoadingProgress(30, "Reading image pixels...");
            window.setTimeout(() => {
                if (loadId !== state.imageLoadId) {
                    return;
                }
                if (state.texture) {
                    gl.deleteTexture(state.texture);
                }
                state.image = img;
                state.imageName = name;
                state.currentImageMetadata = exifMetadata || null;
                state.maskRegions = [];
                state.junkStarFinderRegions = [];
                state.badStarFinderDetections = [];
                state.notStarTiles = [];
                state.notStarTileKeys = new Set();
                state.notStarTilePreview = null;
                state.notStarTilePaintActive = false;
                state.lastNotStarTilePaintPoint = null;
                state.junkStarFinderPreview = null;
                state.junkStarFinderPaintActive = false;
                state.lastJunkStarFinderPoint = null;
                hideZoomCanvas();
                const imageCanvas = document.createElement("canvas");
                imageCanvas.width = img.width;
                imageCanvas.height = img.height;
                const imageContext = imageCanvas.getContext("2d", {willReadFrequently: true});
                imageContext.drawImage(img, 0, 0);
                try {
                    state.imagePixels = imageContext.getImageData(0, 0, img.width, img.height);
                    setLoadingProgress(50, "Adjusting brightness and contrast...");
                    autoAdjustDisplayStretch();
                } catch (error) {
                    state.imagePixels = null;
                    controls.brightness.value = "0.06";
                    controls.contrast.value = "1.00";
                    state.fitMessage = `image pixel readback unavailable for ${name}; display still works, centroid picking disabled`;
                }
                setLoadingProgress(68, "Preparing calibration view...");
                setLoadingProgress(84, "Uploading image texture...");
                state.texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, state.texture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                // Keep WebGL texture rows in the same top-left-origin convention
                // used by the image pixel buffer and the AIDA calibration model.
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                if (state.imagePixels) {
                    state.displayPixels = null;
                    state.highPassCacheKey = "";
                    uploadImagePixelsToTexture();
                } else {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                }
                hint.style.display = "none";
                if (metadataLooksLikeIphone(exifMetadata)) {
                    controls.optmod.value = String(BROWN_CONRADY_OPTMOD);
                    state.baseOptpar = null;
                }
                if (!state.baseOptpar) {
                    applyOptpar(null);
                }
                const appliedExif = applyImageMetadata(metadataName, exifMetadata);
                if (metadataLooksLikeIphone(exifMetadata) && !appliedExif.includes("iPhone camera")) {
                    appliedExif.push("iPhone camera");
                }
                if (appliedExif.length > 0) {
                    state.fitMessage = `image metadata: used EXIF ${appliedExif.join(", ")}`;
                }
                state.pendingMatch = null;
                if (onLoaded) {
                    onLoaded(img);
                }
                if (revokeWhenLoaded) {
                    URL.revokeObjectURL(url);
                }
                setLoadingProgress(96, "Rendering calibration view...");
                recomputeAndRender();
                hideLoadingProgress();
                focusImageWindowSoon();
            }, 0);
        };
        img.onerror = () => {
            if (loadId !== state.imageLoadId) {
                return;
            }
            state.fitMessage = `image load failed: ${name}. If using a web server, serve the AIDA_tools directory rather than only aida_js_calibrator/.`;
            hideLoadingProgress();
            render();
        };
        img.src = url;
    }

    function isHeicFile(file) {
        const name = String(file.name || "").toLowerCase();
        const type = String(file.type || "").toLowerCase();
        return name.endsWith(".heic") || name.endsWith(".heif") ||
            type === "image/heic" || type === "image/heif" ||
            type === "image/heic-sequence" || type === "image/heif-sequence";
    }

    function mergeMetadata(primary, secondary) {
        if (!primary) {
            return secondary || null;
        }
        if (!secondary) {
            return primary;
        }
        return {
            timestampUtc: secondary.timestampUtc || primary.timestampUtc,
            latDeg: Number.isFinite(secondary.latDeg) ? secondary.latDeg : primary.latDeg,
            lonDeg: Number.isFinite(secondary.lonDeg) ? secondary.lonDeg : primary.lonDeg,
            altM: Number.isFinite(secondary.altM) ? secondary.altM : primary.altM,
        };
    }

    async function readImageMetadata(file, buffer) {
        let metadata = AidaTools.parseExifMetadata(buffer);
        if (window.exifr && typeof window.exifr.parse === "function") {
            try {
                const external = await window.exifr.parse(file, {
                    tiff: true,
                    exif: true,
                    gps: true,
                    mergeOutput: true,
                });
                metadata = mergeMetadata(metadata, AidaTools.normalizeExternalExifMetadata(external));
            } catch (error) {
                // EXIF metadata is useful but optional; image loading should continue.
            }
        }
        return metadata;
    }

    async function displayBlobForImage(file) {
        if (!isHeicFile(file)) {
            return {blob: file, displayName: file.name};
        }
        setLoadingProgress(16, `Converting ${file.name} from HEIC...`);
        let blob = null;
        if (typeof window.HeicTo === "function") {
            blob = await window.HeicTo({
                blob: file,
                type: "image/png",
                quality: 1.0,
            });
        } else if (window.HeicTo && typeof window.HeicTo.heicTo === "function") {
            blob = await window.HeicTo.heicTo({
                blob: file,
                type: "image/png",
                quality: 1.0,
            });
        } else if (typeof window.heic2any === "function") {
            const converted = await window.heic2any({
                blob: file,
                toType: "image/png",
                quality: 1.0,
            });
            blob = Array.isArray(converted) ? converted[0] : converted;
        }
        if (!blob) {
            return {blob: file, displayName: file.name};
        }
        return {
            blob,
            displayName: file.name.replace(/\.(heic|heif)$/i, ".png"),
        };
    }

    async function loadImageFile(file) {
        resetForNewImage();
        applyOptpar(null);
        if (state.localImageUrl) {
            URL.revokeObjectURL(state.localImageUrl);
        }
        try {
            const buffer = await file.arrayBuffer();
            const metadata = await readImageMetadata(file, buffer);
            const display = await displayBlobForImage(file);
            state.localImageUrl = URL.createObjectURL(display.blob);
            loadImageSource(state.localImageUrl, display.displayName, null, false, metadata, file.name);
        } catch (error) {
            state.fitMessage = `image load failed: ${file.name}; ${error.message || error}`;
            hideLoadingProgress();
            render();
        }
    }

    function updateDetectionCircleButton() {
        controls.toggleDetectionCircles.textContent =
            state.displayMode === "stellarium" ? "Star pairing view (C)" : "Stellarium view (C)";
        controls.toggleDetectionCircles.classList.toggle("toggle-on", state.displayMode === "stellarium");
    }

    function toggleDetectionCircles() {
        const nextMode = state.displayMode === "stellarium" ? "pairing" : "stellarium";
        clearTransientDebugOverlays();
        setDisplayMode(nextMode);
        state.previousAnnotatedDisplayMode = nextMode;
        state.starMatchMode = false;
        state.pendingMatch = null;
        updateDetectionCircleButton();
        recomputeAndRender();
    }

    function togglePureView() {
        clearTransientDebugOverlays();
        if (state.displayMode === "pureImage") {
            setDisplayMode("pureStellarium");
        } else if (state.displayMode === "pureStellarium") {
            setDisplayMode("pureImage");
        } else {
            if (state.displayMode === "pairing" || state.displayMode === "stellarium") {
                state.previousAnnotatedDisplayMode = state.displayMode;
            }
            setDisplayMode("pureImage");
        }
        state.starMatchMode = false;
        state.deleteDetectionMode = false;
        state.maskMode = false;
        state.zoomMode = false;
        hideZoomCanvas();
        state.pendingMatch = null;
        updateDetectionCircleButton();
        recomputeAndRender();
        playInteractionSound("mode");
    }

    function updateAmbientMusicButton() {
        const playing = Boolean(state.ambientMusic);
        const label = playing ? "Stop ambient sky music" : "Play ambient sky music";
        controls.toggleAmbientMusic.setAttribute("aria-label", label);
        controls.toggleAmbientMusic.classList.toggle("toggle-on", playing);
    }

    function createAmbientVoice(audioContext, destination, frequency, detuneCents, gainValue, waveType) {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const detuneLfo = audioContext.createOscillator();
        const detuneGain = audioContext.createGain();
        osc.type = waveType;
        osc.frequency.value = frequency;
        osc.detune.value = detuneCents;
        gain.gain.value = 0.0001;
        detuneLfo.type = "sine";
        detuneLfo.frequency.value = 0.001 + Math.random() * 0.002;
        detuneGain.gain.value = 0.25 + Math.random() * 0.55;
        detuneLfo.connect(detuneGain);
        detuneGain.connect(osc.detune);
        osc.connect(gain);
        gain.connect(destination);
        osc.start();
        detuneLfo.start();
        gain.gain.setTargetAtTime(gainValue, audioContext.currentTime + 0.05, 3.5);
        return {osc, gain, detuneLfo, detuneGain};
    }

    function createSpaceReverb(audioContext, seconds = 8.5, decay = 4.8) {
        const sampleRate = audioContext.sampleRate;
        const length = Math.max(1, Math.floor(sampleRate * seconds));
        const impulse = audioContext.createBuffer(2, length, sampleRate);
        for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
            const data = impulse.getChannelData(channel);
            for (let i = 0; i < length; i += 1) {
                const t = i / length;
                const envelope = Math.pow(1 - t, decay);
                const shimmer = Math.sin(i * 0.013 + channel * 1.7) * 0.35 + 0.65;
                data[i] = (Math.random() * 2 - 1) * envelope * shimmer;
            }
        }
        const convolver = audioContext.createConvolver();
        convolver.buffer = impulse;
        return convolver;
    }

    function setAmbientChord(music, notes) {
        const now = music.audioContext.currentTime;
        for (const [index, voice] of music.voices.entries()) {
            const note = notes[index % notes.length];
            voice.osc.frequency.setTargetAtTime(note, now, 18.0);
            voice.gain.gain.setTargetAtTime(0.0028 + 0.00045 * (index % 5), now, 14.0);
        }
    }

    function chooseRandomIndex(length, avoid = -1) {
        if (length <= 1) {
            return 0;
        }
        let index = Math.floor(Math.random() * length);
        if (index === avoid) {
            index = (index + 1 + Math.floor(Math.random() * (length - 1))) % length;
        }
        return index;
    }

    function randomChoice(values) {
        return values[Math.floor(Math.random() * values.length)];
    }

    function midiToFrequency(midi) {
        return 440 * Math.pow(2, (midi - 69) / 12);
    }

    function chordFromMidi(root, intervals, upper = []) {
        return intervals.concat(upper).map(interval => midiToFrequency(root + interval));
    }

    function dominantBluesChord(root) {
        return chordFromMidi(root, [0, 7, 10, 14, 16], [22, 24, 26]);
    }

    function minorBluesChord(root) {
        return chordFromMidi(root, [0, 7, 10, 15, 17], [22, 24, 27]);
    }

    function bluesScale(root, octaves = [1, 2]) {
        const degrees = [0, 3, 5, 6, 7, 10, 12];
        const notes = [];
        for (const octave of octaves) {
            for (const degree of degrees) {
                notes.push(midiToFrequency(root + degree + octave * 12));
            }
        }
        return notes;
    }

    function playSputnikBeep(music, when, frequency = 1040) {
        const audioContext = music.audioContext;
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(frequency, when);
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.exponentialRampToValueAtTime(0.030, when + 0.035);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.34);
        osc.connect(gain);
        gain.connect(music.delay);
        gain.connect(music.reverb);
        gain.connect(music.dryGain);
        osc.start(when);
        osc.stop(when + 0.42);
        window.setTimeout(() => {
            osc.disconnect();
            gain.disconnect();
        }, 900);
    }

    function playSputnikPass(music) {
        const now = music.audioContext.currentTime + 0.05;
        const base = [880, 987.77, 1046.50, 1174.66][music.beepIndex % 4];
        const count = 4 + (music.beepIndex % 3);
        for (let i = 0; i < count; i += 1) {
            playSputnikBeep(music, now + i * 0.82, base * (i % 2 === 0 ? 1 : 1.12246));
        }
        music.beepIndex += 1;
    }

    function playWorkflowPulse(music) {
        const now = music.audioContext.currentTime + 0.04;
        const theme = music.themes[music.themeIndex];
        const chord = theme.chords[music.chordIndex];
        const notes = [
            chord[0],
            theme.melody[music.melodyIndex % theme.melody.length],
            theme.melody[(music.melodyIndex + 2) % theme.melody.length],
        ];
        notes.forEach((note, i) => {
            playAmbientBell(music, note * (i === 0 ? 1 : 0.5), now + i * 0.11, 0.0032 + i * 0.0009);
        });
    }

    function playInteractionSound(kind = "click") {
        const music = state.ambientMusic;
        if (!music) {
            return;
        }
        const audioContext = music.audioContext;
        const now = audioContext.currentTime + 0.01;
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const palette = {
            click: {frequency: midiToFrequency(84), gain: 0.0045, length: 0.10},
            mode: {frequency: midiToFrequency(79), gain: 0.0060, length: 0.24},
            pick: {frequency: midiToFrequency(88), gain: 0.0065, length: 0.18},
            fit: {frequency: midiToFrequency(83), gain: 0.0080, length: 0.36},
            delete: {frequency: midiToFrequency(74), gain: 0.0058, length: 0.22},
        };
        const tone = palette[kind] || palette.click;
        osc.type = "sine";
        osc.frequency.setValueAtTime(tone.frequency, now);
        osc.frequency.exponentialRampToValueAtTime(tone.frequency * 1.006, now + tone.length);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(tone.gain, now + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.length);
        osc.connect(gain);
        gain.connect(music.delay);
        gain.connect(music.reverb);
        if (kind === "click" && Math.random() < 0.35) {
            gain.connect(music.dryGain);
        }
        osc.start(now);
        osc.stop(now + tone.length + 0.05);
        window.setTimeout(() => {
            osc.disconnect();
            gain.disconnect();
        }, 700);
    }

    function playPairingRewardSound() {
        const music = state.ambientMusic;
        if (!music) {
            return;
        }
        const theme = music.themes[music.themeIndex];
        const chord = theme.chords[music.chordIndex];
        const now = music.audioContext.currentTime + 0.03;
        const notes = [
            chord[1] * 2,
            chord[2] * 2,
            chord[4] * 2,
            theme.melody[(music.melodyIndex + 2) % theme.melody.length],
        ];
        notes.forEach((note, i) => {
            playAmbientBell(music, note, now + i * 0.18, 0.007 + i * 0.0018);
        });
        music.melodyIndex += 1;
    }

    function playPingSound() {
        const music = state.ambientMusic;
        if (!music) {
            return;
        }
        const now = music.audioContext.currentTime + 0.01;
        playAmbientBell(music, midiToFrequency(91), now, 0.012);
    }

    function playAmbientBell(music, frequency, when, gainValue = 0.018) {
        const audioContext = music.audioContext;
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const filter = audioContext.createBiquadFilter();
        osc.type = "sine";
        osc.frequency.setValueAtTime(frequency, when);
        osc.frequency.exponentialRampToValueAtTime(frequency * 0.999, when + 2.6);
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(2600, when);
        filter.frequency.exponentialRampToValueAtTime(1200, when + 2.8);
        filter.Q.value = 0.35;
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.exponentialRampToValueAtTime(gainValue, when + 0.12);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + 4.6);
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(music.filter);
        gain.connect(music.reverb);
        osc.start(when);
        osc.stop(when + 4.8);
        window.setTimeout(() => {
            osc.disconnect();
            filter.disconnect();
            gain.disconnect();
        }, 5200);
    }

    function advanceAmbientTheme(music) {
        let theme = music.themes[music.themeIndex];
        if (theme.progression) {
            music.barIndex = (music.barIndex + 1) % theme.progression.length;
            if (music.barIndex === 0) {
                music.songCycle += 1;
                if (music.songCycle % 2 === 0) {
                    music.themeIndex = (music.themeIndex + 1) % music.themes.length;
                    theme = music.themes[music.themeIndex];
                    music.songCycle = 0;
                    music.barIndex = 0;
                    music.melodyIndex = 0;
                }
            }
            music.chordIndex = theme.progression[music.barIndex % theme.progression.length];
        } else if (Math.random() < 0.05) {
            music.themeIndex = chooseRandomIndex(music.themes.length, music.themeIndex);
            theme = music.themes[music.themeIndex];
            music.chordIndex = theme.progression ?
                theme.progression[music.barIndex % theme.progression.length] :
                chooseRandomIndex(theme.chords.length);
            music.barIndex = 0;
            music.songCycle = 0;
            music.melodyIndex = 0;
        } else {
            const phraseStep = theme.motion[music.phraseIndex % theme.motion.length];
            const randomStep = Math.random() < 0.08 ? 0 : phraseStep;
            music.chordIndex = (music.chordIndex + randomStep + theme.chords.length) % theme.chords.length;
        }
        music.phraseIndex += 1;
        music.filter.frequency.setTargetAtTime(
            theme.filterHz + (Math.random() * 30 - 15),
            music.audioContext.currentTime,
            24.0
        );
        music.delay.delayTime.setTargetAtTime((theme.delayTime || 1.05) + Math.random() * 0.05, music.audioContext.currentTime, 22.0);
        setAmbientChord(music, theme.chords[music.chordIndex]);
    }

    function playAmbientArpeggio(music) {
        const theme = music.themes[music.themeIndex];
        const chord = theme.chords[music.chordIndex];
        const now = music.audioContext.currentTime + 0.08;
        const pattern = theme.progression ?
            theme.motifs[Math.floor(music.phraseIndex / 2) % theme.motifs.length] :
            randomChoice(theme.motifs);
        const start = music.melodyIndex % theme.melody.length;
        let t = now;
        pattern.forEach((degree, i) => {
            if (degree === null) {
                t += (theme.swingRest || 0.58) + Math.random() * 0.32;
                return;
            }
            const fromMelody = Math.random() < (theme.progression ? 0.78 : 0.68);
            const note = fromMelody
                ? theme.melody[(start + degree) % theme.melody.length]
                : chord[(theme.progression ? degree : music.chordIndex + degree) % chord.length] *
                    (Math.random() < (theme.progression ? 0.18 : 0.24) ? 2 : 1);
            playAmbientBell(music, note, t, 0.0055 + 0.0016 * Math.min(i, 4));
            t += theme.progression ?
                (i % 2 === 0 ? theme.swingLong : theme.swingShort) + Math.random() * 0.08 :
                0.62 + Math.random() * 0.46;
        });
        if (Math.random() < 0.72) {
            const spread = theme.progression ?
                theme.harmonySpreads[music.barIndex % theme.harmonySpreads.length] :
                randomChoice(theme.harmonySpreads);
            spread.forEach((degree, i) => {
                const note = theme.melody[(start + degree) % theme.melody.length];
                playAmbientBell(music, note, now + 0.16 + i * 0.055, 0.0038);
            });
        }
        music.melodyIndex += theme.melodyStep || 1 + Math.floor(Math.random() * 2);
    }

    function scheduleAmbientEvolution(music) {
        music.evolutionTimeoutId = window.setTimeout(() => {
            if (state.ambientMusic !== music) {
                return;
            }
            advanceAmbientTheme(music);
            scheduleAmbientEvolution(music);
        }, music.themes[music.themeIndex].progression ? 8500 + Math.random() * 1600 : 36000 + Math.random() * 42000);
    }

    function scheduleAmbientArpeggio(music) {
        music.arpeggioTimeoutId = window.setTimeout(() => {
            if (state.ambientMusic !== music) {
                return;
            }
            if (Math.random() < 0.82) {
                playAmbientArpeggio(music);
            }
            scheduleAmbientArpeggio(music);
        }, music.themes[music.themeIndex].progression ? 2800 + Math.random() * 1800 : 5600 + Math.random() * 10500);
    }

    function scheduleSputnikPass(music) {
        music.beepTimeoutId = window.setTimeout(() => {
            if (state.ambientMusic !== music) {
                return;
            }
            if (Math.random() < 0.58) {
                playSputnikPass(music);
            }
            scheduleSputnikPass(music);
        }, 18000 + Math.random() * 46000);
    }

    function scheduleWorkflowPulse(music) {
        music.workflowTimeoutId = window.setTimeout(() => {
            if (state.ambientMusic !== music) {
                return;
            }
            if (Math.random() < 0.74) {
                playWorkflowPulse(music);
            }
            scheduleWorkflowPulse(music);
        }, 9000 + Math.random() * 18000);
    }

    async function startAmbientMusic() {
        if (state.ambientMusic) {
            return;
        }
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            state.fitMessage = "ambient music unavailable: Web Audio is not supported in this browser";
            render();
            return;
        }
        const audioContext = new AudioContextClass();
        await audioContext.resume();
        const master = audioContext.createGain();
        const dryGain = audioContext.createGain();
        const wetGain = audioContext.createGain();
        const filter = audioContext.createBiquadFilter();
        const reverb = createSpaceReverb(audioContext);
        const delay = audioContext.createDelay(8.0);
        const delayFeedback = audioContext.createGain();
        const delayWet = audioContext.createGain();
        const lfo = audioContext.createOscillator();
        const lfoGain = audioContext.createGain();
        const themes = [
            {
                name: "off-grid dawn",
                filterHz: 1750,
                motion: [0, 1, 0, 1, 0, 1, 0, 1],
                chords: [
                    chordFromMidi(48, [0, 7, 12, 16, 19], [24, 26, 28]),
                    chordFromMidi(53, [0, 7, 12, 16, 21], [24, 26, 28]),
                    chordFromMidi(55, [0, 7, 12, 14, 19], [24, 26, 31]),
                    chordFromMidi(50, [0, 7, 12, 16, 21], [24, 28, 31]),
                    chordFromMidi(45, [0, 7, 12, 16, 19], [24, 26, 28]),
                ],
                melody: [72, 74, 76, 79, 81, 83, 86, 88].map(midiToFrequency),
                motifs: [[0, 2, 4, null, 3], [1, null, 2, 4, 6], [3, 2, null, 0], [0, 1, 3, 5, null, 4]],
                harmonySpreads: [[0, 2, 4], [1, 3, 5], [0, 3, 6], [2, 4, 7]],
            },
            {
                name: "local inference",
                filterHz: 1900,
                motion: [0, 1, 0, 1, 0, 1, 0, 1],
                chords: [
                    chordFromMidi(45, [0, 7, 12, 16, 21], [24, 28, 31]),
                    chordFromMidi(50, [0, 7, 12, 14, 19], [24, 26, 28]),
                    chordFromMidi(52, [0, 7, 12, 16, 21], [24, 28, 33]),
                    chordFromMidi(43, [0, 7, 12, 17, 21], [24, 29, 31]),
                    chordFromMidi(48, [0, 7, 12, 16, 21], [24, 28, 31]),
                ],
                melody: [69, 71, 74, 76, 78, 81, 83, 86].map(midiToFrequency),
                motifs: [[0, 1, null, 3, 5], [2, 4, 3, null, 1], [0, null, 2, null, 4], [3, 1, 0, null, 5]],
                harmonySpreads: [[0, 2, 4], [1, 3, 5], [0, 3, 6], [2, 5, 7]],
            },
            {
                name: "open-source orbit",
                filterHz: 2150,
                motion: [0, 1, 0, 1, 0, 1, 0, 1],
                chords: [
                    chordFromMidi(50, [0, 7, 12, 16, 21], [24, 28, 33]),
                    chordFromMidi(57, [0, 7, 12, 14, 19], [24, 26, 31]),
                    chordFromMidi(55, [0, 7, 12, 16, 19], [24, 28, 31]),
                    chordFromMidi(52, [0, 7, 12, 16, 21], [24, 28, 33]),
                    chordFromMidi(47, [0, 7, 12, 16, 21], [24, 28, 31]),
                ],
                melody: [74, 76, 79, 81, 83, 86, 88, 91].map(midiToFrequency),
                motifs: [[0, 2, 5, 4], [1, null, 3, 5, 7], [4, 3, 1, null, 2], [0, 2, null, 4, 6]],
                harmonySpreads: [[0, 2, 4], [1, 3, 6], [0, 4, 7], [2, 5, 7]],
            },
            {
                name: "aurora twelve-bar",
                filterHz: 1600,
                delayTime: 1.22,
                progression: [0, 0, 0, 0, 1, 1, 0, 0, 2, 1, 0, 2],
                chords: [
                    dominantBluesChord(48),
                    dominantBluesChord(53),
                    dominantBluesChord(55),
                ],
                melody: bluesScale(48, [1, 2]),
                motifs: [[0, 2, 3, null, 2, 0], [3, 5, 6, null, 5, 3], [6, 5, 3, 2, null, 0], [2, 3, 5, null, 6, 5, 3]],
                harmonySpreads: [[0, 3, 5], [2, 4, 6], [3, 5, 8], [1, 4, 7]],
                melodyStep: 2,
                swingLong: 0.54,
                swingShort: 0.36,
                swingRest: 0.56,
            },
            {
                name: "station shuffle",
                filterHz: 1780,
                delayTime: 1.08,
                progression: [0, 1, 0, 0, 1, 1, 0, 0, 2, 1, 0, 2],
                chords: [
                    dominantBluesChord(45),
                    dominantBluesChord(50),
                    dominantBluesChord(52),
                ],
                melody: bluesScale(45, [1, 2]),
                motifs: [[0, 0, 3, 4, null, 3], [4, 5, 4, 3, null, 0], [3, null, 5, 6, 5], [6, 5, 3, null, 1, 0]],
                harmonySpreads: [[0, 2, 5], [1, 3, 6], [3, 6, 8], [2, 5, 7]],
                melodyStep: 1,
                swingLong: 0.48,
                swingShort: 0.30,
                swingRest: 0.48,
            },
            {
                name: "midnight minor blues",
                filterHz: 1450,
                delayTime: 1.32,
                progression: [0, 0, 0, 0, 1, 1, 0, 0, 2, 1, 0, 2],
                chords: [
                    minorBluesChord(50),
                    minorBluesChord(55),
                    dominantBluesChord(57),
                ],
                melody: bluesScale(50, [1, 2]),
                motifs: [[0, 2, null, 3, 2, 0], [3, 5, 6, 5, null, 3], [6, 8, 6, 5, 3], [5, 3, null, 2, 0]],
                harmonySpreads: [[0, 2, 5], [2, 5, 7], [3, 6, 9], [1, 4, 6]],
                melodyStep: 3,
                swingLong: 0.66,
                swingShort: 0.42,
                swingRest: 0.70,
            },
            {
                name: "turnaround at tromso",
                filterHz: 2050,
                delayTime: 1.16,
                progression: [0, 1, 0, 0, 1, 1, 0, 0, 2, 1, 0, 2],
                chords: [
                    dominantBluesChord(43),
                    dominantBluesChord(48),
                    dominantBluesChord(50),
                ],
                melody: bluesScale(43, [2, 3]),
                motifs: [[0, 3, 4, 5, null, 4], [5, 6, 5, 3, null, 0], [3, 4, null, 6, 5, 3], [8, 6, 5, 3, 1, 0]],
                harmonySpreads: [[0, 3, 6], [2, 5, 8], [4, 6, 9], [1, 4, 7]],
                melodyStep: 2,
                swingLong: 0.44,
                swingShort: 0.29,
                swingRest: 0.44,
            },
        ];
        const voices = [];
        master.gain.value = 0.0001;
        dryGain.gain.value = 0.30;
        wetGain.gain.value = 0.42;
        delay.delayTime.value = 1.05;
        delayFeedback.gain.value = 0.28;
        delayWet.gain.value = 0.22;
        filter.type = "lowpass";
        filter.frequency.value = 2100;
        filter.Q.value = 0.25;
        lfo.type = "sine";
        lfo.frequency.value = 0.004;
        lfoGain.gain.value = 55;
        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);
        master.connect(filter);
        filter.connect(dryGain);
        filter.connect(reverb);
        filter.connect(delay);
        delay.connect(delayFeedback);
        delayFeedback.connect(delay);
        delay.connect(delayWet);
        reverb.connect(wetGain);
        dryGain.connect(audioContext.destination);
        wetGain.connect(audioContext.destination);
        delayWet.connect(audioContext.destination);
        lfo.start();
        for (let i = 0; i < 8; i += 1) {
            voices.push(createAmbientVoice(
                audioContext,
                master,
                themes[0].chords[0][i % themes[0].chords[0].length] * (i < 2 ? 0.5 : 1),
                (i - 3.5) * 0.35,
                0.0018 + 0.0003 * (i % 4),
                i % 5 === 0 ? "triangle" : "sine"
            ));
        }
        master.gain.setTargetAtTime(0.24, audioContext.currentTime + 0.1, 5.0);
        const music = {
            audioContext,
            master,
            dryGain,
            wetGain,
            filter,
            reverb,
            delay,
            delayFeedback,
            delayWet,
            lfo,
            voices,
            themes,
            themeIndex: 0,
            chordIndex: 0,
            barIndex: 0,
            songCycle: 0,
            phraseIndex: 0,
            melodyIndex: 0,
            beepIndex: 0,
            evolutionTimeoutId: null,
            arpeggioTimeoutId: null,
            beepTimeoutId: null,
            workflowTimeoutId: null,
        };
        state.ambientMusic = music;
        scheduleAmbientEvolution(music);
        scheduleAmbientArpeggio(music);
        scheduleSputnikPass(music);
        scheduleWorkflowPulse(music);
        updateAmbientMusicButton();
    }

    function stopAmbientMusic() {
        const music = state.ambientMusic;
        if (!music) {
            return;
        }
        window.clearTimeout(music.evolutionTimeoutId);
        window.clearTimeout(music.arpeggioTimeoutId);
        window.clearTimeout(music.beepTimeoutId);
        window.clearTimeout(music.workflowTimeoutId);
        const now = music.audioContext.currentTime;
        music.master.gain.setTargetAtTime(0.0001, now, 1.2);
        window.setTimeout(() => {
            for (const voice of music.voices) {
                voice.osc.stop();
                voice.detuneLfo.stop();
                voice.osc.disconnect();
                voice.gain.disconnect();
                voice.detuneLfo.disconnect();
                voice.detuneGain.disconnect();
            }
            music.lfo.stop();
            music.lfo.disconnect();
            music.master.disconnect();
            music.dryGain.disconnect();
            music.wetGain.disconnect();
            music.filter.disconnect();
            music.reverb.disconnect();
            music.delay.disconnect();
            music.delayFeedback.disconnect();
            music.delayWet.disconnect();
            music.audioContext.close();
        }, 1800);
        state.ambientMusic = null;
        updateAmbientMusicButton();
    }

    function toggleAmbientMusic() {
        if (state.ambientMusic) {
            stopAmbientMusic();
        } else {
            startAmbientMusic().catch(error => {
                state.fitMessage = `ambient music failed: ${error.message || error}`;
                state.ambientMusic = null;
                updateAmbientMusicButton();
                render();
            });
        }
    }

    function enableStarPairingMode(armed = false) {
        setDisplayMode("pairing");
        state.starMatchMode = armed;
        state.deleteDetectionMode = false;
        state.maskMode = false;
        state.zoomMode = false;
        if (!armed) {
            hideZoomCanvas();
        }
        updateDetectionCircleButton();
        recomputeAndRender();
    }

    function updateStarNameButton() {
        controls.toggleStarNames.textContent =
            state.showStarNames ? "Hide star names (N)" : "Show star names (N)";
        controls.toggleStarNames.classList.toggle("toggle-on", state.showStarNames);
    }

    function toggleStarNames() {
        state.showStarNames = !state.showStarNames;
        if (Object.prototype.hasOwnProperty.call(state.starNamesByMode, state.displayMode)) {
            state.starNamesByMode[state.displayMode] = state.showStarNames;
        }
        updateStarNameButton();
        render();
    }

    function badStarFinderDetectionExists(detection) {
        return state.badStarFinderDetections.some(existing =>
            Math.hypot(existing.x - detection.x, existing.y - detection.y) <= 1.5
        );
    }

    function markBadStarFinderRegion(rawX, rawY, radius = 100) {
        if (!state.image) {
            return {added: 0, region: null};
        }
        const cx = Math.round(rawX);
        const cy = Math.round(rawY);
        const r = Math.round(radius);
        const r2 = r * r;
        const region = {x: cx, y: cy, radius: r, detectionCount: 0};
        let added = 0;
        for (const detection of activeDetectedStars()) {
            const dx = detection.x - cx;
            const dy = detection.y - cy;
            if (dx * dx + dy * dy > r2 || badStarFinderDetectionExists(detection)) {
                continue;
            }
            state.badStarFinderDetections.push({
                id: state.badStarFinderDetections.length + 1,
                x: detection.x,
                y: detection.y,
                sourceDetectionId: detection.id || null,
                markedBy: {x: cx, y: cy, radius: r},
            });
            added += 1;
        }
        region.detectionCount = added;
        state.junkStarFinderRegions.push(region);
        state.junkStarFinderPreview = {x: cx, y: cy, radius: r};
        updateAutoMatches();
        return {added, region};
    }

    function handleBadStarFinderPaint(event) {
        const imagePoint = eventToImagePixel(event);
        if (!imagePoint) {
            return;
        }
        const radius = 100;
        if (state.lastJunkStarFinderPoint) {
            const dx = imagePoint.x - state.lastJunkStarFinderPoint.x;
            const dy = imagePoint.y - state.lastJunkStarFinderPoint.y;
            if (dx * dx + dy * dy < (radius * 0.35) * (radius * 0.35)) {
                state.junkStarFinderPreview = {x: imagePoint.x, y: imagePoint.y, radius};
                render();
                return;
            }
        }
        const result = markBadStarFinderRegion(imagePoint.x, imagePoint.y, radius);
        state.lastJunkStarFinderPoint = {x: imagePoint.x, y: imagePoint.y};
        state.fitMessage = `marked ${result.added} bad star finder detection${result.added === 1 ? "" : "s"} ` +
            `within 100 px of raw image pixel ${imagePoint.x.toFixed(1)}, ${imagePoint.y.toFixed(1)}`;
        render();
    }

    function notStarTileForPoint(rawX, rawY) {
        if (!state.image) {
            return null;
        }
        const x0 = Math.floor(rawX / NOT_STAR_TILE_SIZE) * NOT_STAR_TILE_SIZE;
        const y0 = Math.floor(rawY / NOT_STAR_TILE_SIZE) * NOT_STAR_TILE_SIZE;
        const width = Math.min(NOT_STAR_TILE_SIZE, state.image.width - x0);
        const height = Math.min(NOT_STAR_TILE_SIZE, state.image.height - y0);
        if (width <= 0 || height <= 0) {
            return null;
        }
        return {x0, y0, width, height};
    }

    function notStarTileKey(tile) {
        return `${tile.x0},${tile.y0}`;
    }

    function notStarTilesAlongPath(startPoint, endPoint) {
        if (!endPoint) {
            return [];
        }
        if (!startPoint) {
            const tile = notStarTileForPoint(endPoint.x, endPoint.y);
            return tile ? [tile] : [];
        }
        const dx = endPoint.x - startPoint.x;
        const dy = endPoint.y - startPoint.y;
        const distance = Math.hypot(dx, dy);
        const step = Math.max(8, NOT_STAR_TILE_SIZE * 0.25);
        const steps = Math.max(1, Math.ceil(distance / step));
        const tiles = [];
        const seen = new Set();
        for (let i = 0; i <= steps; i += 1) {
            const t = i / steps;
            const tile = notStarTileForPoint(startPoint.x + dx * t, startPoint.y + dy * t);
            if (!tile) {
                continue;
            }
            const key = notStarTileKey(tile);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            tiles.push(tile);
        }
        return tiles;
    }

    function handleNotStarTilePaint(event) {
        const imagePoint = eventToImagePixel(event);
        if (!imagePoint) {
            state.notStarTilePreview = null;
            state.lastNotStarTilePaintPoint = null;
            render();
            return;
        }
        const currentTile = notStarTileForPoint(imagePoint.x, imagePoint.y);
        if (!currentTile) {
            return;
        }
        state.notStarTilePreview = currentTile;
        const tiles = notStarTilesAlongPath(state.lastNotStarTilePaintPoint, imagePoint);
        state.lastNotStarTilePaintPoint = {x: imagePoint.x, y: imagePoint.y};
        if (!tiles.length) {
            render();
            return;
        }
        const records = [];
        for (const tile of tiles) {
            const key = notStarTileKey(tile);
            if (state.notStarTileKeys.has(key)) {
                continue;
            }
            state.notStarTileKeys.add(key);
            const record = {
                ...tile,
                id: state.notStarTiles.length + 1,
            };
            state.notStarTiles.push(record);
            records.push(record);
        }
        if (!records.length) {
            render();
            return;
        }
        state.detectorCache = null;
        const noun = records.length === 1 ? "tile" : "tiles";
        state.fitMessage = `masked ${records.length} not-star 128x128 ${noun}`;
        render();
    }

    function focusImageWindow() {
        if (document.activeElement === canvas) {
            return;
        }
        canvas.focus({preventScroll: true});
    }

    function focusImageWindowSoon() {
        window.setTimeout(focusImageWindow, 0);
    }

    const controlsPanel = document.querySelector(".controls");
    if (controlsPanel) {
        controlsPanel.addEventListener("click", event => {
            if (event.target.closest("button")) {
                focusImageWindowSoon();
            }
        });
        controlsPanel.addEventListener("change", focusImageWindowSoon);
    }

    controls.file.addEventListener("change", () => {
        if (controls.file.files.length > 0) {
            loadImageFile(controls.file.files[0]);
        }
    });

    for (const el of document.querySelectorAll(".controls input, .controls select")) {
        if (el !== controls.file &&
                el !== controls.highPassImage && el !== controls.highPassWidth &&
                el !== controls.maxMag && el !== controls.optmod &&
                el !== controls.exportLanguage) {
            el.addEventListener("input", () => {
                syncModelOptparFromControls();
                recomputeAndRender();
            });
        }
    }
    controls.highPassImage.addEventListener("change", refreshDisplayImage);
    controls.highPassWidth.addEventListener("input", refreshDisplayImage);
    controls.maxMag.addEventListener("input", () => {
        if (Object.prototype.hasOwnProperty.call(state.maxMagByMode, state.displayMode)) {
            state.maxMagByMode[state.displayMode] = Number(controls.maxMag.value) || 4.0;
        }
        playInteractionSound("click");
        recomputeAndRender();
    });
    controls.optmod.addEventListener("input", () => {
        updateOptmodUi();
        state.lastFitVector = null;
        clearFitUndoStack();
        recomputeAndRender();
    });

    controls.flipX.addEventListener("click", () => {
        state.flipX = !state.flipX;
        playInteractionSound("mode");
        updateAutoMatches();
        render();
    });
    controls.flipY.addEventListener("click", () => {
        state.flipY = !state.flipY;
        playInteractionSound("mode");
        updateAutoMatches();
        render();
    });
    controls.flipImageX.addEventListener("click", () => {
        state.imageFlipX = !state.imageFlipX;
        playInteractionSound("mode");
        updateAutoMatches();
        render();
    });
    controls.flipImageY.addEventListener("click", () => {
        state.imageFlipY = !state.imageFlipY;
        playInteractionSound("mode");
        updateAutoMatches();
        render();
    });
    controls.toggleRaDecGrid.addEventListener("click", () => {
        state.showRaDecGrid = !state.showRaDecGrid;
        controls.toggleRaDecGrid.textContent = state.showRaDecGrid ? "Hide RA/Dec grid" : "Show RA/Dec grid";
        playInteractionSound("mode");
        render();
    });
    controls.toggleAzElGrid.addEventListener("click", () => {
        toggleAzElGrid();
    });
    controls.toggleDetectionCircles.addEventListener("click", toggleDetectionCircles);
    controls.toggleStarNames.addEventListener("click", toggleStarNames);
    controls.luckyFit.addEventListener("click", () => {
        playInteractionSound("fit");
        feelingLuckyFit();
    });
    controls.toggleAmbientMusic.addEventListener("click", toggleAmbientMusic);
    controls.toggleFitResiduals.addEventListener("click", toggleFitResiduals);
    densityPopupClose.addEventListener("click", () => {
        clearDensityEstimate();
        render();
        focusImageWindowSoon();
    });
    controls.resetOffset.addEventListener("click", () => {
        setCameraAnglesFromBoresightAzEl(0, 90);
        syncModelOptparFromControls();
        playInteractionSound("mode");
        recomputeAndRender();
    });
    controls.fitLens.addEventListener("click", () => {
        playInteractionSound("fit");
        fitLensFromMatches();
    });
    controls.fitLensLm.addEventListener("click", () => {
        playInteractionSound("fit");
        fitLensLevenbergMarquardt();
    });
    controls.undoFit.addEventListener("click", () => {
        playInteractionSound("mode");
        undoFit();
    });
    controls.copyOptpar.addEventListener("click", () => {
        playInteractionSound("click");
        const language = selectedExportLanguage();
        copyTextToClipboard(optparArrayText(language), `optpar ${language} array`);
    });
    controls.copyPythonMapper.addEventListener("click", () => {
        playInteractionSound("click");
        const language = selectedExportLanguage();
        copyTextToClipboard(exportFunctionText(language), `${language} mapper code`);
    });
    if (controls.localTestCaseTools) {
        controls.localTestCaseTools.hidden = !LOCAL_TEST_CASES_ENABLED;
    }
    if (LOCAL_TEST_CASES_ENABLED && controls.submitTestCase) {
        controls.submitTestCase.addEventListener("click", () => {
            playInteractionSound("click");
            submitCurrentTestCase();
        });
    }
    if (LOCAL_TEST_CASES_ENABLED && controls.loadTestCase) {
        controls.loadTestCase.addEventListener("click", () => {
            playInteractionSound("click");
            loadSelectedTestCase();
        });
    }
    controls.clearMatches.addEventListener("click", () => {
        playInteractionSound("delete");
        clearIdentifiedStars();
    });

    canvas.addEventListener("pointerdown", event => {
        focusImageWindow();
        if (state.maskMode && event.button === 0) {
            event.preventDefault();
            state.notStarTilePaintActive = true;
            state.lastNotStarTilePaintPoint = null;
            handleNotStarTilePaint(event);
            playInteractionSound("delete");
            canvas.setPointerCapture(event.pointerId);
            return;
        }
        if (state.deleteDetectionMode && event.button === 0) {
            event.preventDefault();
            handleDeletePairingClick(event);
            playInteractionSound("delete");
            return;
        }
        if (state.displayMode === "pairing" && state.starMatchMode && event.button === 0) {
            event.preventDefault();
            handleStarMatchClick(event);
            playInteractionSound("pick");
            return;
        }
        if (state.displayMode === "pairing" && state.pendingMatch && event.button === 0) {
            event.preventDefault();
            handleCatalogPairClick(event);
            return;
        }
        playPingSound();
        state.dragging = true;
        state.lensDragMode = event.button === 0 ? "zenithPosition" : "azimuthGridRoll";
        state.lastMouse = [event.clientX, event.clientY];
        canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event => {
        if (state.maskMode) {
            const imagePoint = eventToImagePixel(event);
            state.notStarTilePreview = imagePoint ? notStarTileForPoint(imagePoint.x, imagePoint.y) : null;
            if (state.notStarTilePaintActive) {
                event.preventDefault();
                handleNotStarTilePaint(event);
                return;
            }
            render();
        }
        if (state.zoomMode || state.starMatchMode) {
            updateZoomCanvas(event);
        }
        if (!state.dragging || !state.image) {
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const dxCss = event.clientX - state.lastMouse[0];
        const dyCss = event.clientY - state.lastMouse[1];
        const alpha = Number(controls.rotAlpha.value) || 0;
        const beta = Number(controls.rotBeta.value) || 0;
        const gamma = Number(controls.rotGamma.value) || 0;
        if (state.lensDragMode === "zenithPosition") {
            const zenith = zenithCanvasPixelForCameraAngles(alpha, beta, gamma);
            if (!zenith) {
                return;
            }
            solveCameraAnglesForZenithPixel(
                [zenith[0] + dxCss * dpr * 0.45, zenith[1] + dyCss * dpr * 0.45],
                alpha,
                beta,
                gamma
            );
            syncModelOptparFromControls();
            recomputeAndRender();
        } else if (state.lensDragMode === "azimuthGridRoll") {
            const zenith = zenithCanvasPixelForCameraAngles(alpha, beta, gamma);
            if (!zenith) {
                return;
            }
            const newGamma = wrapDegrees180(gamma + dxCss * 0.06);
            controls.rotGamma.value = newGamma.toPrecision(12);
            solveCameraAnglesForZenithPixel(zenith, alpha, beta, newGamma);
            syncModelOptparFromControls();
            recomputeAndRender();
        }
        state.lastMouse = [event.clientX, event.clientY];
    });
    canvas.addEventListener("pointerup", event => {
        state.notStarTilePaintActive = false;
        state.lastNotStarTilePaintPoint = null;
        state.junkStarFinderPaintActive = false;
        state.lastJunkStarFinderPoint = null;
        state.dragging = false;
        state.lensDragMode = "none";
        if (canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
        }
    });
    canvas.addEventListener("contextmenu", event => {
        event.preventDefault();
    });
    canvas.addEventListener("pointerleave", () => {
        hideZoomCanvas();
        if (!state.notStarTilePaintActive && !state.junkStarFinderPaintActive) {
            state.notStarTilePreview = null;
            state.junkStarFinderPreview = null;
            render();
        }
    });
    canvas.addEventListener("wheel", event => {
        event.preventDefault();
        const currentX = Number(controls.fScaleX.value) || 1.0;
        const currentY = Number(controls.fScaleY.value) || 1.0;
        const factor = Math.exp(-event.deltaY * 0.00045);
        const scaleFocal = value => {
            const sign = value < 0 ? -1 : 1;
            return sign * Math.max(0.05, Math.min(10.0, Math.abs(value) * factor));
        };
        controls.fScaleX.value = scaleFocal(currentX).toFixed(4);
        controls.fScaleY.value = scaleFocal(currentY).toFixed(4);
        syncModelOptparFromControls();
        recomputeAndRender();
    }, {passive: false});

    document.addEventListener("keydown", event => {
        const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
        if (tag === "input" || tag === "select" || tag === "textarea") {
            return;
        }
        if ((event.key === "z" || event.key === "Z") &&
                ((isMacPlatform() && event.metaKey) || (!isMacPlatform() && event.ctrlKey)) &&
                !event.shiftKey && !event.altKey && !event.repeat) {
            event.preventDefault();
            undoFit();
            return;
        }
        if ((event.key === "s" || event.key === "S") && !event.repeat) {
            event.preventDefault();
            enableStarPairingMode(true);
            playInteractionSound("pick");
        } else if ((event.key === "d" || event.key === "D") && !event.repeat) {
            event.preventDefault();
            state.deleteDetectionMode = true;
            state.starMatchMode = false;
            state.maskMode = false;
            state.zoomMode = false;
            hideZoomCanvas();
            state.pendingMatch = null;
            playInteractionSound("delete");
            render();
        } else if ((event.key === "m" || event.key === "M") && !event.repeat) {
            event.preventDefault();
            state.maskMode = true;
            state.deleteDetectionMode = false;
            state.starMatchMode = false;
            state.zoomMode = false;
            state.notStarTilePreview = null;
            state.notStarTilePaintActive = false;
            state.lastNotStarTilePaintPoint = null;
            state.junkStarFinderPreview = null;
            state.junkStarFinderPaintActive = false;
            state.lastJunkStarFinderPoint = null;
            hideZoomCanvas();
            state.pendingMatch = null;
            playInteractionSound("mode");
            render();
        } else if ((event.key === "z" || event.key === "Z") && !event.repeat) {
            event.preventDefault();
            state.zoomMode = true;
            state.maskMode = false;
            state.deleteDetectionMode = false;
            state.starMatchMode = false;
            state.pendingMatch = null;
            playInteractionSound("mode");
            render();
        } else if ((event.key === "c" || event.key === "C") && !event.repeat) {
            event.preventDefault();
            toggleDetectionCircles();
            playInteractionSound("mode");
        } else if ((event.key === "x" || event.key === "X") && !event.repeat) {
            event.preventDefault();
            togglePureView();
        } else if ((event.key === "n" || event.key === "N") && !event.repeat) {
            event.preventDefault();
            toggleStarNames();
            playInteractionSound("mode");
        } else if ((event.key === "h" || event.key === "H") && !event.repeat) {
            event.preventDefault();
            state.showAutoDetectionMarkers = !state.showAutoDetectionMarkers;
            playInteractionSound("mode");
            render();
        } else if ((event.key === "k" || event.key === "K") && !event.repeat) {
            event.preventDefault();
            state.showKdePositionDots = !state.showKdePositionDots;
            playInteractionSound("mode");
            render();
        } else if ((event.key === "t" || event.key === "T") && !event.repeat) {
            event.preventDefault();
            toggleAsterismLines();
            playInteractionSound("mode");
        } else if ((event.key === "r" || event.key === "R") && !event.repeat) {
            event.preventDefault();
            toggleFitResiduals();
            playInteractionSound("mode");
        } else if ((event.key === "a" || event.key === "A") && !event.repeat) {
            event.preventDefault();
            toggleAzElGrid();
        } else if ((event.key === "l" || event.key === "L") && !event.repeat) {
            event.preventDefault();
            playInteractionSound("fit");
            feelingLuckyFit();
        } else if ((event.key === "f" || event.key === "F") && !event.repeat) {
            event.preventDefault();
            playInteractionSound("fit");
            fitLensFromMatches();
        } else if ((event.key === "g" || event.key === "G") && !event.repeat) {
            event.preventDefault();
            playInteractionSound("fit");
            fitLensLevenbergMarquardt();
        } else if (event.key === "Escape" && state.pendingMatch) {
            event.preventDefault();
            clearDensityEstimate();
            state.pendingMatch = null;
            render();
        } else if (event.key === "Escape" && densityPopup.classList.contains("visible")) {
            event.preventDefault();
            clearDensityEstimate();
            render();
        } else if (event.key === "Escape" && state.starMatchMode) {
            event.preventDefault();
            state.starMatchMode = false;
            setDisplayMode("pairing");
            state.pendingMatch = null;
            clearDensityEstimate();
            updateDetectionCircleButton();
            recomputeAndRender();
        }
    });
    document.addEventListener("keyup", event => {
        if (event.key === "s" || event.key === "S") {
            event.preventDefault();
            state.starMatchMode = false;
            if (!state.centroidPreview || Date.now() >= state.centroidPreview.expiresAt) {
                hideZoomCanvas();
            }
            render();
            return;
        }
        if (event.key === "d" || event.key === "D") {
            event.preventDefault();
            state.deleteDetectionMode = false;
            render();
        } else if (event.key === "m" || event.key === "M") {
            event.preventDefault();
            state.maskMode = false;
            state.notStarTilePreview = null;
            state.notStarTilePaintActive = false;
            state.lastNotStarTilePaintPoint = null;
            state.junkStarFinderPreview = null;
            state.junkStarFinderPaintActive = false;
            state.lastJunkStarFinderPoint = null;
            render();
        } else if (event.key === "z" || event.key === "Z") {
            event.preventDefault();
            state.zoomMode = false;
            hideZoomCanvas();
            render();
        }
    });

    window.addEventListener("resize", render);
    window.addEventListener("beforeunload", stopAmbientMusic);
    window.addEventListener("load", () => {
        state.lastLensEquation = "";
        updateLensEquation(currentOptpar(), Number(controls.optmod.value));
        refreshTestCaseList();
        if (!state.image) {
            resetForNewImage();
            applyOptpar(null);
            loadImageSource(defaultImage.url, defaultImage.name);
        }
    });
    updateDetectionCircleButton();
    updateStarNameButton();
    updateAmbientMusicButton();
    updateFitResidualButton();
    updateUndoFitButton();
    updateOptmodUi();
    render();
})();
