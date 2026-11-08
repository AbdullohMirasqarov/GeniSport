"use strict";

// Phone navigation is independent of the desktop header.
const MobileNav = {
  routes: ["train", "battle", "stats", "leaderboard"],
  closeTimer: null,
  init() {
    const get = id => document.getElementById(id);
    const dialog = get("mobile-account");
    get("mobile-profile").addEventListener("click", () => {
      if (!App.user || !window.matchMedia("(max-width: 700px)").matches) return;
      clearTimeout(MobileNav.closeTimer);
      dialog.classList.remove("is-closing");
      MobileNav.updateProfile();
      get("mobile-profile-message").textContent = "";
      dialog.showModal();
      document.body.classList.add("mobile-account-open");
      get("mobile-profile").setAttribute("aria-expanded", "true");
      get("mobile-tabs").style.setProperty("--active-index", 4);
      get("mobile-account-close").focus();
    });
    get("mobile-account-close").addEventListener("click", () => MobileNav.close());
    dialog.addEventListener("click", event => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) MobileNav.close();
    });
    dialog.addEventListener("cancel", event => { event.preventDefault(); MobileNav.close(); });
    dialog.addEventListener("close", () => {
      document.body.classList.remove("mobile-account-open");
      get("mobile-profile").setAttribute("aria-expanded", "false");
      MobileNav.sync(Router.current);
    });
    get("mobile-signout").addEventListener("click", () => { MobileNav.close(true); App.logout(); });
    get("mobile-weight-form").addEventListener("submit", async event => {
      event.preventDefault();
      const value = Number(get("mobile-weight").value);
      const message = get("mobile-profile-message");
      if (!Number.isFinite(value) || value < 25 || value > 300) {
        message.textContent = "Enter a weight between 25 and 300 kg.";
        return;
      }
      const button = get("mobile-weight-save");
      button.disabled = true;
      try {
        const user = await API.updateMe(value);
        if (!App.user) return;
        App.user = user;
        App.renderUserbox();
        message.textContent = "Body weight updated.";
      } catch (error) { message.textContent = error.message; }
      finally { button.disabled = false; }
    });
    window.matchMedia("(max-width: 700px)").addEventListener("change", event => {
      if (!event.matches) MobileNav.close(true);
    });
  },
  sync(route) {
    const nav = document.getElementById("mobile-tabs");
    const signedIn = route !== "auth" && !!API.token;
    nav.hidden = !signedIn;
    document.body.classList.toggle("mobile-authed", signedIn);
    if (!signedIn) MobileNav.close(true);
    const index = MobileNav.routes.indexOf(route);
    if (index >= 0) nav.style.setProperty("--active-index", index);
    nav.querySelectorAll("[data-mobile-route]").forEach(link => {
      const active = link.dataset.mobileRoute === route;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  },
  updateProfile() {
    if (!App.user) return;
    document.getElementById("mobile-avatar").textContent = App.user.username.charAt(0).toUpperCase();
    document.getElementById("mobile-username").textContent = App.user.username;
    document.getElementById("mobile-weight").value = App.user.weight_kg;
  },
  close(immediate = false) {
    const dialog = document.getElementById("mobile-account");
    if (!dialog.open) return;
    clearTimeout(MobileNav.closeTimer);
    if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { dialog.close(); return; }
    dialog.classList.add("is-closing");
    MobileNav.closeTimer = setTimeout(() => { dialog.close(); dialog.classList.remove("is-closing"); }, 180);
  },
};
