// @ts-check
// Start, waiting and outcome screens (design doc 17.3, 17.4). The menu only collects choices and calls
// `actions`; main.js owns the connection.
// Doc choices: createMenu takes the content as an optional third argument (ship and opponent lists come
// from it); `actions` also carries rematch(), toMenu() and offline() for the overlay buttons; extra
// method showWaiting(code, link) covers a pvp match waiting for its second captain; showStart(note)
// can show one line of feedback (for example why a join failed).

import { CONTENT } from '../shared/content/index.js';
import { TICK_MS } from '../shared/sim/index.js';
import { button, h } from './hud.js';

/** @typedef {import('../shared/sim/types.js').Content} Content */
/**
 * @typedef {object} MenuActions
 * @property {(opts: { ship: string, ai: string }) => void} playAi
 * @property {(opts: object) => void} watchAi
 * @property {(opts: object) => void} createPvp
 * @property {(code: string, opts: { spectate?: boolean }) => void} join
 * @property {() => void} rematch
 * @property {() => void} toMenu
 * @property {(() => void) | null} [offline]   absent when already offline
 */

/** A row of mutually exclusive choices, each a 44 px button with aria-pressed. */
function choice(label, options, value, onPick) {
  const buttons = options.map(([key, text]) => button({ class: 'opt', 'aria-pressed': String(key === value),
    onclick: () => {
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === key)));
      onPick(key);
    } }, text));
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), h('div', { class: 'opts', role: 'group', 'aria-label': label }, ...buttons));
}

/** @param {number} ticks */
function duration(ticks) {
  const s = Math.round((ticks * TICK_MS) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

/** @param {string} side */
const titleCase = (side) => side.charAt(0).toUpperCase() + side.slice(1);

/**
 * @param {HTMLElement} root @param {MenuActions} actions @param {Content} [content]
 */
export function createMenu(root, actions, content = CONTENT) {
  const show = (...kids) => {
    root.replaceChildren(...kids);
    root.hidden = false;
  };

  return {
    /** @param {string} [note] */
    showStart(note) {
      const ships = Object.entries(content.ships).map(([id, bp]) => [id, bp.name]);
      const foes = Object.entries(content.ai).map(([id, p]) => [id, p.label]);
      const pick = { ship: ships[0][0], ai: foes.find(([id]) => id === 'captain')?.[0] ?? foes[0][0] };
      const blurb = h('p', { class: 'blurb' }, content.ships[pick.ship].blurb ?? '');
      const code = /** @type {HTMLInputElement} */ (h('input', { class: 'code', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters',
        spellcheck: 'false', maxlength: 5, placeholder: 'Code', 'aria-label': 'Match code' }));
      const joinWith = (spectate) => {
        const c = code.value.trim().toUpperCase();
        if (c) actions.join(c, { spectate });
        else code.focus();
      };
      show(h('div', { class: 'panel start' },
        h('h1', { class: 'title' }, 'Faster than Lumos'),
        h('p', { class: 'lede' }, 'Real-time ship duels. Route reactor power, pick your targets, keep the crew alive.'),
        note ? h('p', { class: 'note', role: 'alert' }, note) : null,
        h('section', { class: 'group primary' },
          h('h2', {}, 'Fight the AI'),
          choice('Your ship', ships, pick.ship, (v) => { pick.ship = v; blurb.textContent = content.ships[v].blurb ?? ''; }),
          blurb,
          choice('Opponent', foes, pick.ai, (v) => { pick.ai = v; }),
          button({ class: 'go', onclick: () => actions.playAi({ ship: pick.ship, ai: pick.ai }) }, 'Start the fight')),
        h('section', { class: 'group' },
          h('h2', {}, 'With others'),
          h('div', { class: 'row' },
            button({ class: 'btn', onclick: () => actions.createPvp({}) }, 'Duel a friend'),
            button({ class: 'btn', onclick: () => actions.watchAi({}) }, 'Watch two AIs')),
          h('form', { class: 'row join', onsubmit: (e) => { e.preventDefault(); joinWith(false); } },
            code,
            h('button', { class: 'btn', type: 'submit' }, 'Join'),
            button({ class: 'btn quiet', onclick: () => joinWith(true) }, 'Spectate'))),
        actions.offline ? button({ class: 'link', onclick: actions.offline }, 'Play offline in this browser') : null,
      ));
      document.body.dataset.menu = 'start';
    },

    /** @param {string} matchCode @param {string} link */
    showWaiting(matchCode, link) {
      const copy = button({ class: 'btn', onclick: async () => {
        try {
          await navigator.clipboard.writeText(link);
          copy.textContent = 'Link copied';
        } catch {
          copy.textContent = 'Copy failed';
        }
      } }, 'Copy invite link');
      show(h('div', { class: 'panel wait' },
        h('h2', {}, 'Waiting for a second captain'),
        h('p', { class: 'lede' }, 'Send this code or link to a friend. The fight starts when they board.'),
        h('p', { class: 'bigcode', 'aria-label': 'Match code' }, matchCode),
        h('p', { class: 'share' }, link),
        h('div', { class: 'row' }, copy, button({ class: 'btn quiet', onclick: actions.toMenu }, 'Menu'))));
      document.body.dataset.menu = 'waiting';
    },

    /** @param {any} snap @param {{ side: string | null } | null} you */
    showOutcome(snap, you) {
      const outcome = snap.view.outcome;
      const winner = outcome?.winner ?? null;
      const head = winner === null ? 'Draw'
        : you?.side ? (winner === you.side ? 'Victory' : 'Defeat')
        : `${titleCase(winner)} wins`;
      const lost = Object.values(snap.view.ships).filter((s) => s.out)
        .map((s) => `${s.name} ${s.out === 'hull' ? 'broke apart' : 'lost its crew'}.`);
      const facts = [...lost, `${duration(outcome?.tick ?? snap.tick)} of fighting.`];
      show(h('div', { class: `panel outcome ${head === 'Victory' ? 'won' : head === 'Defeat' ? 'lost' : ''}` },
        h('h2', { class: 'verdict' }, head),
        h('p', { class: 'lede' }, facts.join(' ')),
        snap.seed !== undefined ? h('p', { class: 'seed' }, `Seed ${snap.seed}`) : null,
        h('div', { class: 'row' },
          button({ class: 'go', onclick: actions.rematch }, 'Rematch'),
          button({ class: 'btn quiet', onclick: actions.toMenu }, 'Menu'))));
      document.body.dataset.menu = 'outcome';
    },

    hide() {
      root.hidden = true;
      root.replaceChildren();
      delete document.body.dataset.menu;
    },
  };
}
