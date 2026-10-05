/** A positive integer from the environment variable `name`, else `fallback`. */
export function envNumber(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
