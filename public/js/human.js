/* Tells the server a person is here, the first time someone actually does
   something. Opening a page is not enough (bots do that too). Sends no data
   beyond "yes"; the server ties it to the anonymous cookie it already set. */
(function () {
  "use strict";
  if (navigator.webdriver) return; // automated browsers say so themselves
  var ACTS = ["pointerdown", "pointermove", "touchstart", "keydown", "wheel"];
  function seen(e) {
    if (!e.isTrusted) return; // faked by a script, not by a hand
    ACTS.forEach(function (n) {
      removeEventListener(n, seen, true);
    });
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"type":"human"}',
      keepalive: true,
    }).catch(function () {});
  }
  ACTS.forEach(function (n) {
    addEventListener(n, seen, { capture: true, passive: true });
  });
})();
