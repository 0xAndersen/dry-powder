/** A deterministic 5x5 mirrored pattern from an address: tells accounts apart at a glance, nothing more. */
export function Avatar({ address, size = 40 }: { address: string; size?: number }) {
  const hex = address.toLowerCase().replace(/^0x/, "").padEnd(40, "0");
  const byte = (i: number) => parseInt(hex.slice((i * 2) % 40, (i * 2) % 40 + 2), 16);
  const hue = Math.round((byte(0) / 255) * 360);
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      if (byte(1 + y * 3 + x) % 2 === 0) continue;
      cells.push({ x, y });
      if (x < 2) cells.push({ x: 4 - x, y });
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 7 7" aria-hidden="true" className="shrink-0 rounded-[var(--radius-ui)]" style={{ background: `hsl(${hue} 30% 16%)` }}>
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x + 1} y={c.y + 1} width={1.02} height={1.02} fill={`hsl(${hue} 55% 66%)`} />
      ))}
    </svg>
  );
}
