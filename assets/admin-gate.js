// Password check for the admin bubble. The password sits in plain sight here
// and that's fine. All it unlocks is a console that re-reads public guide pages.
// The token that actually matters stays on the Worker.

const ADMIN_PASSWORD = "Atlas123";
const SESSION_KEY = "sop-admin-unlocked";

const trigger = document.getElementById("admin-trigger");
const pop = document.getElementById("admin-pop");
const form = document.getElementById("admin-form");
const input = document.getElementById("admin-pass");
const error = document.getElementById("admin-error");

init();

function init() {
  if (!trigger || !pop) return;

  trigger.addEventListener("click", () => {
    if (pop.hidden) {
      open();
    } else {
      close();
    }
  });

  form.addEventListener("submit", onSubmit);

  // Click outside to dismiss.
  document.addEventListener("pointerdown", (event) => {
    if (pop.hidden) return;
    if (pop.contains(event.target) || trigger.contains(event.target)) return;
    close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pop.hidden) {
      close();
      trigger.focus();
    }
  });
}

function open() {
  pop.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  error.hidden = true;
  input.value = "";
  // Next frame, so the bubble has a layout before focus moves into it.
  requestAnimationFrame(() => input.focus());
}

function close() {
  pop.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  error.hidden = true;
  input.value = "";
}

function onSubmit(event) {
  event.preventDefault();

  if (input.value === ADMIN_PASSWORD) {
    sessionStorage.setItem(SESSION_KEY, "1");
    // Full page load keeps the console's CSS and JS off the search view.
    window.location.href = "admin.html";
    return;
  }

  error.hidden = false;
  input.value = "";
  input.focus();
  form.classList.remove("is-shaking");
  void form.offsetWidth;
  form.classList.add("is-shaking");
}
