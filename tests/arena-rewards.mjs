import { applyMatch, newProfile, ARENA_WIN, upgradeChest } from '../src/data/economy.js';
import { ARENAS } from '../src/data/arenas.js';
import { AI_DIFFICULTIES } from '../src/sim/aiDifficulty.js';

let failures = 0;
const check = (name, ok, info = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};
const win = (trophies, arenaId) => {
  const p = { ...newProfile(), trophies };
  const gold = p.gold;
  const s = applyMatch(p, { result: 'win', myCrowns: 3, deck: [], deployed: {}, oppTrophies: trophies, arenaId });
  return { s, goldGain: p.gold - gold };
};

check('every arena has a reward row and a bot', ARENA_WIN.length === ARENAS.length && AI_DIFFICULTIES.length === ARENAS.length);
check('win gold rises arena by arena', ARENA_WIN.every((w, i) => i === 0 || w.gold > ARENA_WIN[i - 1].gold));
check('bot level bonus rises arena by arena', AI_DIFFICULTIES.every((d, i) => i === 0 || d.levelBonus > AI_DIFFICULTIES[i - 1].levelBonus));

const low = win(0, 'goblin-stadium');
const high = win(1600, 'pump-palace');
check('a win pays its arena gold', low.goldGain === ARENA_WIN[0].gold && high.goldGain === ARENA_WIN[4].gold, `${low.goldGain} / ${high.goldGain}`);
check('higher arenas give more XP', high.s.xp > low.s.xp);
check('top arenas upgrade the chest', high.s.chest === upgradeChest('wooden', 1) && low.s.chest === 'wooden', `${low.s.chest} / ${high.s.chest}`);

const home = win(1600, 'pump-palace').s.delta;
const oneDown = win(1600, 'frozen-peak').s;
const farm = win(1600, 'goblin-stadium').s;
check('one arena down: half the trophies', oneDown.delta === Math.round(home / 2) && oneDown.reduced, `${oneDown.delta} vs ${home}`);
check('farming the first arena gives no trophies', farm.delta === 0 && farm.reduced);
check('...and only first-arena gold', win(1600, 'goblin-stadium').goldGain === ARENA_WIN[0].gold);
{
  const p = { ...newProfile(), trophies: 1600 };
  const s = applyMatch(p, { result: 'loss', myCrowns: 0, deck: [], deployed: {}, oppTrophies: 1600, arenaId: 'goblin-stadium' });
  check('losing in a low arena still costs trophies', s.delta < 0, `${s.delta}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
