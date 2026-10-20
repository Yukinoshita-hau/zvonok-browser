import { it, expect } from "vitest";
it("blocks nonpublic destinations", async () => {
  const { publicIPv4 } = await import("./proxy-policy.mjs");
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.17.0.1",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "100.64.0.1",
    "224.0.0.1",
  ])
    expect(publicIPv4(ip)).toBe(false);
  expect(publicIPv4("93.184.216.34")).toBe(true);
});
