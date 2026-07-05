// A stable per-instance accent, picked from the vendored token palette (never a
// hard-coded color — standing rule 10). Same instance id → same color, so the
// dot beside each workflow reads consistently across the estate.
const PALETTE = [
  '--color--orange-500',
  '--color--purple-500',
  '--color--blue-500',
  '--color--green-600',
  '--color--mint-500',
  '--color--pink-500',
];

export function instanceColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `var(${PALETTE[h % PALETTE.length]})`;
}
