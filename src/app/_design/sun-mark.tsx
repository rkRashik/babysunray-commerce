/** The sunrise device (arc and three rays) as an interface ornament for good moments, never a copy of the logo. Decorative. */
export function SunMark({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 40 24" className={className} fill="none" stroke="currentColor" strokeLinecap="round">
      <path d="M5 22.5C8 12 32 12 35 22.5" strokeWidth="3.2" />
      <path className="fl-rays" d="M20 2v6M7.5 6.5l3 4.6M32.5 6.5l-3 4.6" strokeWidth="3" />
    </svg>
  );
}
