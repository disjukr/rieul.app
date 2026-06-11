export function className(
  ...parts: Array<false | string | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
