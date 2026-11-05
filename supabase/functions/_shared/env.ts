export const env = (name: string, fallback?: string): string => {
  const v = Deno.env.get(name) ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
};
export const envOpt = (name: string): string | undefined => Deno.env.get(name) || undefined;
