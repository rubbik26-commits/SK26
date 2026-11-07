// Document extraction for the Deal Calculator (audit item 27): PDF.js page
// text extraction, a Tesseract OCR fallback for scanned PDFs, and plain-text
// passthrough. Everything runs locally from vendored assets — no CDN.
let pdfjsLib = null;
async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import("/vendor/pdfjs/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
  return pdfjsLib;
}
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/tesseract/tesseract.min.js";
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error("OCR engine failed to load"));
    document.head.appendChild(s);
  });
}

// Extracts text from a File. onStatus(message) narrates progress. Returns
// { text, method: "text" | "pdf-text" | "pdf-ocr" }.
export async function extractDocText(file, onStatus = () => {}) {
  const isPdf = /pdf$/i.test(file.name) || file.type === "application/pdf";
  if (!isPdf) {
    onStatus("Reading document…");
    return { text: await file.text(), method: "text" };
  }
  onStatus("Reading PDF…");
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = Math.min(doc.numPages, 12);
  let text = "";
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((it) => it.str).join(" ") + "\n";
  }
  if (text.replace(/\s+/g, " ").trim().length >= 40 * pages * 0.5) {
    return { text, method: "pdf-text" };
  }
  // Scanned PDF — rasterize pages and OCR them (item 27 OCR fallback).
  onStatus("No embedded text — running OCR (this can take a minute)…");
  const T = await loadTesseract();
  const worker = await T.createWorker("eng", 1, {
    workerPath: "/vendor/tesseract/worker.min.js",
    corePath: "/vendor/tesseract/core",
    langPath: "/vendor/tesseract/lang"
  });
  try {
    let ocrText = "";
    const ocrPages = Math.min(doc.numPages, 6);
    for (let i = 1; i <= ocrPages; i++) {
      onStatus(`OCR — page ${i} of ${ocrPages}…`);
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const { data } = await worker.recognize(canvas);
      ocrText += (data.text ?? "") + "\n";
    }
    return { text: ocrText, method: "pdf-ocr" };
  } finally {
    await worker.terminate();
  }
}

export const EXTRACT_FIELD_LABELS = {
  noi: "NOI (annual)", grossIncome: "Gross income (annual)",
  operatingExpenses: "Operating expenses (annual)", units: "Units / keys", askingPrice: "Asking price"
};
