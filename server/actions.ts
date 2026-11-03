// Door controls for the camera views: unlock or lock the front door, open/close
// the middle garage door. Only the actions listed in config.actions can run; the page
// names an action, never an HA service. Every use is written to HA's logbook.
import type { createHa } from "./ha.js";

type Ha = ReturnType<typeof createHa>;
// One button per lock. `unlock` lists what Unlock fires if that's more than the
// lock itself (e.g. an HA button for a door strike); the lock's state shows on the button.
type LockConfig = { id: string; name: string; lock: string; unlock?: string[] };
export type ActionsConfig = {
  locks?: LockConfig[];
  unlock?: { entities: string[]; lock: string };           // older single-lock form
  garage: { cover: string };                               // the garage door cover (open/close and its state)
};

export function createActions(ha: Ha, cfg: ActionsConfig) {
  const log = (message: string) =>
    ha.call("logbook", "log", { name: "Kitchen Frame", message, domain: "lock" }).catch(() => {});
  const locks: LockConfig[] = cfg.locks
    ?? (cfg.unlock ? [{ id: "front", name: "Front door", lock: cfg.unlock.lock, unlock: cfg.unlock.entities }] : []);
  const find = (id: string) => {
    const l = locks.find((l) => l.id === id);
    if (!l) throw new Error(`unknown lock ${id}`);
    return l;
  };

  async function unlock(l: LockConfig) {
    await Promise.all((l.unlock ?? [l.lock]).map((e) => {
      const [domain] = e.split(".");
      if (domain === "button") return ha.call("button", "press", { entity_id: e });
      if (domain === "lock") return ha.call("lock", "unlock", { entity_id: e });
      throw new Error(`can't unlock with ${e}`);
    }));
    log(`unlocked the ${l.name.toLowerCase()} from the kitchen frame`);
  }

  async function lock(l: LockConfig) {
    await ha.call("lock", "lock", { entity_id: l.lock });
    log(`locked the ${l.name.toLowerCase()} from the kitchen frame`);
  }

  // Open if closed, close if open. The cover's own actions pulse the relay and
  // refuse unsafe moves (open only after 5 s closed, close only after 20 s open).
  async function garage() {
    const { state } = await ha.state(cfg.garage.cover);
    const service = state === "closed" ? "open_cover" : "close_cover";
    await ha.call("cover", service, { entity_id: cfg.garage.cover });
    log(`${service === "open_cover" ? "opened" : "closed"} the middle garage door from the kitchen frame`);
  }

  // Current state for the buttons.
  async function states() {
    const [lockStates, garage] = await Promise.all([
      Promise.all(locks.map((l) => ha.state(l.lock).then((s) => s.state, () => "unavailable"))),
      ha.state(cfg.garage.cover),
    ]);
    return { locks: locks.map((l, i) => ({ id: l.id, name: l.name, state: lockStates[i] })), garage: garage.state };
  }

  // Actions: "unlock:<lock id>", "lock:<lock id>", "garage".
  return {
    states,
    run: async (action: string) => {
      const [verb, id] = action.split(":");
      if (verb === "unlock" && id) return unlock(find(id));
      if (verb === "lock" && id) return lock(find(id));
      if (action === "garage") return garage();
      throw new Error(`unknown action ${action}`);
    },
  };
}
