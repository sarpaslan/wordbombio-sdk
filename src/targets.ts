export interface Target {
  game: string;
  gameWs: string;
  social: string;
  player: string;
  ws2: string;
}

export const TARGETS = {
  local: {
    game: "http://localhost:2567",
    gameWs: "ws://localhost:2567",
    social: "http://localhost:3006",
    player: "http://localhost:3007",
    ws2: "ws://localhost:3011",
  },
  prod: {
    game: "https://io.wordbomb.io",
    gameWs: "wss://io.wordbomb.io",
    social: "https://social.wordbomb.io",
    player: "https://player.wordbomb.io",
    ws2: "wss://ws2.wordbomb.io",
  },
} satisfies Record<string, Target>;

export type TargetName = keyof typeof TARGETS;

export function resolveTarget(target: TargetName | Target): Target {
  return typeof target === "string" ? TARGETS[target] : target;
}
