/* GUI-only: the same original settings panel becomes a phone drawer. */
(() => {
    "use strict";
    const body = document.body;
    const panel = document.getElementById("settingsPanel");
    const gear = document.getElementById("settingsToggle");
    const close = document.getElementById("settingsClose");
    const backdrop = document.getElementById("settingsBackdrop");
    const toggle = document.getElementById("phoneModeToggle");
    const viewer = document.getElementById("viewerPanel");
    const header = document.querySelector("header");
    let preference = null;
    try {
        const saved = localStorage.getItem("wisc-phone-mode");
        preference = saved === "phone" ? true : saved === "desktop" ? false : null;
    } catch { /* A private browser may disable storage; phone mode still works. */ }

    function drawer(open, restoreFocus = true) {
        open = Boolean(open && body.classList.contains("phone-mode"));
        body.classList.toggle("settings-open", open);
        gear.setAttribute("aria-expanded", String(open));
        backdrop.hidden = !open;
        panel.setAttribute("aria-hidden", String(body.classList.contains("phone-mode") && !open));
        viewer.inert = open;
        header.inert = open;
        if (open) {
            panel.setAttribute("role", "dialog");
            panel.setAttribute("aria-modal", "true");
            close.focus();
        } else {
            panel.removeAttribute("role");
            panel.removeAttribute("aria-modal");
            if (restoreFocus && body.classList.contains("phone-mode")) gear.focus();
        }
    }
    function mode(phone) {
        body.classList.toggle("phone-mode", phone);
        toggle.setAttribute("aria-pressed", String(phone));
        toggle.textContent = phone ? "Desktop" : "Phone mode";
        drawer(false, false);
        document.dispatchEvent(new CustomEvent("wisc-phone-mode", {detail: phone}));
    }
    const automaticPhone = () => window.innerWidth <= 760 ||
        window.matchMedia("(pointer:coarse)").matches && window.innerWidth <= 1100;
    mode(preference ?? automaticPhone());
    gear.addEventListener("click", () => drawer(true));
    close.addEventListener("click", () => drawer(false));
    document.addEventListener("wisc-close-settings", () => drawer(false));
    backdrop.addEventListener("click", () => drawer(false));
    toggle.addEventListener("click", () => {
        preference = !body.classList.contains("phone-mode");
        mode(preference);
        try { localStorage.setItem("wisc-phone-mode", preference ? "phone" : "desktop"); } catch {}
        window.dispatchEvent(new Event("resize"));
    });
    window.addEventListener("resize", () => {
        if (preference === null && automaticPhone() !== body.classList.contains("phone-mode")) mode(automaticPhone());
    });
    document.addEventListener("keydown", event => {
        if (!body.classList.contains("settings-open")) return;
        if (event.key === "Escape") { event.preventDefault(); drawer(false); }
        if (event.key === "Tab") {
            const items = [...panel.querySelectorAll("button,input,select,textarea,a[href],[tabindex]")]
                .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
            const first = items[0], last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    window.dispatchEvent(new Event("resize"));
})();
