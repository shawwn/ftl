// @ts-check
// AI difficulty profiles (design doc 8.7). Read only by shared/ai, so the integer rule does not apply.

/** @type {Record<string, import('../sim/types.js').AiProfile>} */
export default {
  drifter: { label: 'Target practice', persona: 'Drifter', passive: true,
             thinkEveryTicks: 20, reactionTicks: 0, temperature: 1, patienceMs: 0, crew: false,
             weights: { offense: 1, defense: 1 } },
  novice:  { label: 'Novice',  persona: 'Gloam', passive: false,
             thinkEveryTicks: 30, reactionTicks: 20, temperature: 0.8, patienceMs: 0, crew: false,
             weights: { offense: 1, defense: 1 } },
  captain: { label: 'Captain', persona: 'Gloam', passive: false,
             thinkEveryTicks: 16, reactionTicks: 10, temperature: 0.3, patienceMs: 3000, crew: true,
             weights: { offense: 1, defense: 1 } },
  ace:     { label: 'Ace',     persona: 'Gloam', passive: false,
             thinkEveryTicks: 6,  reactionTicks: 4,  temperature: 0.05, patienceMs: 5000, crew: true,
             weights: { offense: 1.2, defense: 1 } },
};
