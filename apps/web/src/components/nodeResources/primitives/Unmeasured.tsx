/** A compact cell's unmeasured value: a dash on screen, the word for screen readers. */
export function Unmeasured() {
  return (
    <span>
      <span aria-hidden="true">-</span>
      <span className="sr-only">unmeasured</span>
    </span>
  );
}
