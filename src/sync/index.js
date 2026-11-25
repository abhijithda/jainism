// sync/index.js — Wires sync together for app.js: config → sign-in → Drive → engine → the Settings/Home section.
// Does nothing at all (no network, nothing from Google, no extra storage) unless assets/sync-config.json has a client ID.

import { loadSyncConfig } from './sync-config.js';
import { createAuth } from './auth.js';
import { createDrive } from './drive.js';
import { createSyncEngine } from './sync-engine.js';
import { initSyncUi } from './sync-ui.js';
import { buildBlockIndex } from '../core/blocks.js';
import { repaintReadTicks } from '../core/read-tick.js';
import { getReadBlocks, countTrackableBlocks, updateProgressDisplay } from '../core/read-tracking.js';

/**
 * @param {{data: Array, onApplied?: (changed:{read:boolean, study:boolean}) => void}} args
 *   onApplied: called after another device's ticks / study answers were stored here (refresh Home, the study panel…)
 */
export async function initSync({ data, onApplied = () => {} }) {
    const config = await loadSyncConfig();
    if (!config.enabled) return null;

    const { blockById } = buildBlockIndex(data);
    const auth = createAuth({ clientId: config.clientId });
    const drive = createDrive();
    let ui = { render() {} };
    const engine = createSyncEngine({
        storage: localStorage, auth, drive,
        isKnownId: id => Object.prototype.hasOwnProperty.call(blockById, id),
        onStatus: snap => ui.render(snap),
        onApplied: changed => {
            if (changed.read) {
                const set = getReadBlocks(localStorage);
                repaintReadTicks(set);
                updateProgressDisplay(set, countTrackableBlocks(data));
            }
            onApplied(changed);
        },
    });
    ui = initSyncUi({ engine, auth });
    engine.start();
    return engine;
}
