/* Label modelled figures where they are read, not only where they are served.
 *
 * The debt maturity wall on My Desk has Balance / Rate / Matures columns, and
 * the compiled frontend formats the maturity as a date. But ACRIS records the
 * mortgage, not its terms: there is no maturity date and no rate in the public
 * record. The date is modelled from the recording date plus a typical term and
 * is only accurate to the year; the balance is the recorded original principal
 * with no amortisation assumed.
 *
 * The API says so in the payload (server/production-maturity.js emits
 * `estimated`, `methodology` and per-field flags). A payload flag nobody reads
 * is not a disclosure, so this marks the rendered table too: the affected
 * column headers get an "est." marker, and the methodology is printed under
 * the table. The compiled bundle is not modified — this annotates what it
 * rendered, and re-applies if the table re-renders.
 */
(function () {
  "use strict";

  var NOTE_ID = "maturity-estimate-note";
  var MARK = " (est.)";
  var ESTIMATED_COLUMNS = /^(Balance|Matures)$/;

  function methodology() {
    return "Maturity and balance are modelled, not recorded. ACRIS registers the mortgage, not its terms: "
      + "maturity is estimated from the recording date plus a typical term for the loan type and is accurate "
      + "to the year, not the day. Balance is the recorded original principal — no amortisation is assumed. "
      + "Rate is shown only where the public record carries one.";
  }

  function maturityTable() {
    var tables = document.querySelectorAll("table");
    for (var i = 0; i < tables.length; i++) {
      var heads = tables[i].querySelectorAll("thead th");
      if (!heads.length) continue;
      var labels = [];
      for (var j = 0; j < heads.length; j++) labels.push((heads[j].textContent || "").trim());
      // The maturity wall is the only table carrying all three of these.
      if (labels.indexOf("Balance") >= 0 && labels.indexOf("Matures") >= 0 && labels.indexOf("Lender") >= 0) {
        return { table: tables[i], heads: heads };
      }
    }
    return null;
  }

  function annotate() {
    var found = maturityTable();
    if (!found) return;

    for (var i = 0; i < found.heads.length; i++) {
      var th = found.heads[i];
      var text = (th.textContent || "").trim();
      if (ESTIMATED_COLUMNS.test(text) && th.getAttribute("data-estimate-marked") !== "1") {
        th.setAttribute("data-estimate-marked", "1");
        th.setAttribute("title", methodology());
        var mark = document.createElement("span");
        mark.textContent = MARK;
        mark.style.fontWeight = "400";
        mark.style.opacity = "0.7";
        th.appendChild(mark);
      }
    }

    var host = found.table.parentNode;
    if (host && !document.getElementById(NOTE_ID)) {
      var note = document.createElement("p");
      note.id = NOTE_ID;
      note.textContent = methodology();
      note.style.cssText = "margin:0;padding:8px 16px 10px;font-size:10px;line-height:1.45;opacity:0.72;";
      if (host.nextSibling) host.parentNode.insertBefore(note, host.nextSibling);
      else host.parentNode.appendChild(note);
    }
  }

  function watch() {
    annotate();
    // The desk re-renders when its query resolves, which replaces the table.
    var observer = new MutationObserver(function () { annotate(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();
