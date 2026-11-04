/**
 * Admin entry point on the search page.
 *
 * The password is deliberately visible in this file. It is a speed bump, not a
 * security boundary: the only thing it protects is a console that can re-read
 * public Scribe pages. The credential that actually matters lives in the
 * Worker, never here.
 */

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

  // Clicking anywhere outside the bubble dismisses it.
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
  // Focus on the next frame so the bubble is laid out before the caret moves.
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
    // Full navigation keeps the console's CSS and JS off the search page.
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
