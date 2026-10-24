import { Type, type Static } from "@sinclair/typebox";
const obj = <T extends Record<string, import("@sinclair/typebox").TSchema>>(
  properties: T,
) => Type.Object(properties, { additionalProperties: false });
const x = Type.Integer({ minimum: 0, maximum: 1919 }),
  y = Type.Integer({ minimum: 0, maximum: 1079 });
export const Navigate = obj({
  url: Type.String({ maxLength: 2048, minLength: 1 }),
});
export const Empty = obj({});
export const Input = Type.Union([
  obj({ type: Type.Literal("mouseMove"), x, y }),
  obj({
    type: Type.Literal("mouseClick"),
    x,
    y,
    button: Type.Union(
      (["left", "middle", "right"] as const).map((v) => Type.Literal(v)),
    ),
  }),
  obj({
    type: Type.Literal("wheel"),
    x,
    y,
    deltaX: Type.Number({ minimum: -2000, maximum: 2000 }),
    deltaY: Type.Number({ minimum: -2000, maximum: 2000 }),
  }),
  obj({
    type: Type.Literal("text"),
    text: Type.String({ maxLength: 1000, minLength: 1 }),
  }),
  obj({
    type: Type.Literal("keyPress"),
    key: Type.Union(
      (
        [
          "Enter",
          "Tab",
          "Shift+Tab",
          "Backspace",
          "Delete",
          "Escape",
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
          "PageUp",
          "PageDown",
          "Control+A",
        ] as const
      ).map((v) => Type.Literal(v)),
    ),
  }),
]);
export type InputAction = Static<typeof Input>;
export interface Collaboration {
  identity:string; role:'owner'|'guest'; ownerPresent:boolean; participants:string[]; sessionId:string; epoch:string;
  controller:string; generation:number; expiresAt:number; serverTime:number; request?:string; result:string; membershipExpiresAt?:number;
}
export interface BrowserSession {
  collaboration?: Collaboration;
  sessionId: string;
  ownerId: string;
  status: "creating" | "active" | "closing" | "closed" | "crashed" | "expired";
  browserReady?: boolean;
  media?: { epoch: string; room: string; publisher: string; profile: string; width: number; height: number; fps: number; state: "starting" | "streaming" | "media_reconnecting" | "closed" };
  navigationError?: "timeout" | "upstream" | "browser_unavailable";
  createdAt: string;
  lastActivityAt: string;
  currentUrl: string;
  tabs?: { id: string; url: string; title: string }[];
  activeTabId?: string;
  workerId: string;
  expiresAt: string;
  idleExpiresAt: string;
}
export const allowedHosts = new Set([
  "example.com",
  "www.selenium.dev",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "googleusercontent.com",
  "youtube.com",
  "youtu.be",
  "googlevideo.com",
  "ytimg.com",
  "ggpht.com",
]);
export function allowedUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === "443") &&
      [...allowedHosts].some(
        (host) => u.hostname === host || u.hostname.endsWith(`.${host}`),
      )
    );
  } catch {
    return false;
  }
}
