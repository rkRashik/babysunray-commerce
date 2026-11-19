"use client";

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="of-btn of-btn-primary"
    >
      Print
    </button>
  );
}
