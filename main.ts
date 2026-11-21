// sokoban-fast 1.0.0: a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
// Rooms are solved one at a time (a box never leaves its room in an optimal line),
// each by breadth-first search over pushes, so the first solution found uses the
// fewest pushes. Dead squares and frozen 2x2 blocks prune positions no push can save.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MAX_STATES = 250_000;

// Directions: dx, dy, walk letter, push letter.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall
  goals: number[]; // sorted cell indices
  boxes: number[]; // sorted cell indices
  player: number; // cell index
}

function parse(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall no matter what it shows.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Squares a lone box can be pushed from onto some goal, found by pulling
// backwards from the goals: a box on a square outside this set can never reach
// a goal, so it is a dead square.
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.wall.length);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * b.w + dx;
      const from = x - d; // the square the box is pulled from
      const stand = from - d; // where the player stands to pull it
      if (!b.wall[from] && !b.wall[stand] && !live[from]) {
        live[from] = 1;
        queue.push(from);
      }
    }
  }
  return live;
}

// The squares the player can reach from `from` with `boxMask` in the way.
// Returns the lowest square of the region (its canonical name) and marks the
// region in `seen` under `stamp`.
function reachRegion(
  b: Board,
  boxMask: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const w = b.w;
    // up, down, left, right
    const qs = [p - w, p + w, p - 1, p + 1];
    for (const q of qs) {
      if (b.wall[q] === 0 && boxMask[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Whether the box just pushed onto `t` is caught in a frozen 2x2 block:
// four squares, all wall or box, with a box among them off its goal.
function frozen2x2(b: Board, boxMask: Uint8Array, goal: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c = a + 1;
    const d = a + w;
    const e = d + 1;
    if (
      (b.wall[a] || boxMask[a]) &&
      (b.wall[c] || boxMask[c]) &&
      (b.wall[d] || boxMask[d]) &&
      (b.wall[e] || boxMask[e])
    ) {
      if (
        (boxMask[a] && !goal[a]) ||
        (boxMask[c] && !goal[c]) ||
        (boxMask[d] && !goal[d]) ||
        (boxMask[e] && !goal[e])
      )
        return true;
    }
  }
  return false;
}

// A state's key: the region's lowest square followed by the boxes' squares,
// as digits in base `size` (exact while size ** (boxes + 1) stays under 2 ** 53).
function stateKey(boxes: number[], low: number, size: number): number {
  let k = low;
  for (const x of boxes) k = k * size + x;
  return k;
}

// The shortest walk from `from` to `to` around walls and boxes (lowercase LURD).
// Throws if `to` is unreachable.
function walkTo(b: Board, boxMask: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.wall.length).fill(-1);
  const how = new Array<string>(b.wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (b.wall[q] || boxMask[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: target out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

// The square the player stands on after `moves` (LURD, case aside) from `from`.
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Solution {
  pushes: number;
  moves: string;
}

// Push-optimal solution of one board by breadth-first search over pushes.
// A state is the boxes' squares plus the player's reachable region; states are
// expanded in order of pushes made, so the first solved state met is optimal.
// Returns null when the search gives up (state cap) or the board is unsolvable.
function solvePushOptimal(b: Board, maxStates = MAX_STATES): Solution | null {
  const size = b.wall.length;
  const goal = new Uint8Array(size);
  for (const g of b.goals) goal[g] = 1;
  const live = liveSquares(b);
  if (b.boxes.some((x) => !live[x])) return null;
  const boxMask = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((x) => goal[x]);

  // States in discovery order: boxes, player square, parent index.
  const statesBoxes: number[][] = [b.boxes.slice()];
  const statesPlayer: number[] = [b.player];
  const parent: number[] = [-1];
  const index = new Map<number, number>();
  for (const x of b.boxes) boxMask[x] = 1;
  const low0 = reachRegion(b, boxMask, b.player, seen, ++stamp, stack);
  index.set(stateKey(b.boxes, low0, size), 0);
  for (const x of b.boxes) boxMask[x] = 0;

  let found = solved(b.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head]!;
    for (const x of boxes) boxMask[x] = 1;
    const here = ++stamp;
    reachRegion(b, boxMask, statesPlayer[head]!, seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * b.w + dx;
        const dest = box + d;
        // The player must stand on the square behind the box, and the
        // destination must be open floor, live, and free of boxes.
        if (seen[box - d] !== here || b.wall[dest] || boxMask[dest] || !live[dest]) continue;
        boxMask[box] = 0;
        boxMask[dest] = 1;
        const frozen = frozen2x2(b, boxMask, goal, dest);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = dest;
          next.sort((x, y) => x - y);
          key = stateKey(next, reachRegion(b, boxMask, box, mark, ++stamp, stack), size);
        }
        boxMask[dest] = 0;
        boxMask[box] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) boxMask[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next!);
        statesPlayer.push(box);
        parent.push(head);
        if (solved(next!)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) boxMask[x] = 0;
  }
  if (found < 0) return null;

  // Walk the parent chain back, then turn each push into a walk plus the push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = boxes.find((x) => !nextBoxes.includes(x))!;
    const to = nextBoxes.find((x) => !boxes.includes(x))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * b.w + dx === d)!;
    for (const x of boxes) boxMask[x] = 1;
    moves += walkTo(b, boxMask, player, from - d);
    for (const x of boxes) boxMask[x] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

// Split a level into rooms: cut the dead squares of the player's row (the
// hallway, where a box reaches no goal) out of the floor; each remaining part
// holding boxes is a room. Null when the level is no set of rooms.
function roomsOf(b: Board): Room[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.wall.length);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) if (!b.wall[i] && !live[i]) cut[i] = 1;
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < b.wall.length; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * b.w + dx;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const x of b.boxes) rooms[part[x]!]!.boxes.push(x);
  for (const g of b.goals) if (part[g] >= 0) rooms[part[g]!]!.goals.push(g);
  if (b.goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Solve a level room by room: each room's push-optimal solution in turn, the
// other rooms' boxes standing as walls (on their goals once their room is
// done), the player walking on from where the last room left it. A box never
// leaves its room, so the rooms' optima add up to the level's.
function solveLevel(b: Board): Solution | null {
  const rooms = roomsOf(b);
  if (rooms === null) return solvePushOptimal(b);
  let player = b.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = b.wall.slice();
    for (const other of rooms)
      if (other !== room) for (const x of other.done ? other.goals : other.boxes) wall[x] = 1;
    const sub: Board = {
      w: b.w,
      h: b.h,
      wall,
      goals: room.goals.slice().sort((a, b2) => a - b2),
      boxes: room.boxes.slice().sort((a, b2) => a - b2),
      player,
    };
    const solved = solvePushOptimal(sub);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(b.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

function solve(text: string): string {
  const solved = solveLevel(parse(text));
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(IN).sort()) {
  const moves = solve(readFileSync(join(IN, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'solution.txt'), `${moves}\n`);
}
