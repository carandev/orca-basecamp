import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../../src/domain/sync.mjs';

const MAP = { todo: ['8', '12'], 'in-progress': ['8'], 'in-review': ['9'] };
const card = (over) => ({ kind: 'card', statusToColumn: MAP, rule: 'orca-wins', ...over });
const todo = (over) => ({ kind: 'todo', statusToColumn: {}, rule: 'orca-wins', ...over });

// Each row: [name, input, expected]. Absent keys in `expected` must be absent in the result.
const rows = [
  // --- no baseline: snapshot only ---
  [
    'card, no baseline: snapshot, no write',
    card({ baseline: null, orca: 'in-review', bc: '9' }),
    { baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' } }
  ],
  [
    'to-do, no baseline, completed: snapshot without lastOpenOrca',
    todo({ baseline: null, orca: 'completed', bc: 'completed' }),
    { baseline: { orca: 'completed', bc: 'completed' } }
  ],
  // --- neither changed ---
  [
    'neither changed: no write',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'in-review', bc: '9' }),
    { baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' } }
  ],
  // --- only Orca changed ---
  [
    'only O (mapped status): move the card',
    card({ baseline: { orca: 'in-progress', bc: '8', lastOpenOrca: 'in-progress' }, orca: 'in-review', bc: '8' }),
    { baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, writeBc: '9' }
  ],
  [
    'only O completed on a card: cards done',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'completed', bc: '9' }),
    { baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-review' }, writeBc: 'completed' }
  ],
  [
    'only O completed on a to-do: complete',
    todo({ baseline: { orca: 'in-progress', bc: 'open', lastOpenOrca: 'in-progress' }, orca: 'completed', bc: 'open' }),
    { baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-progress' }, writeBc: 'completed' }
  ],
  [
    'only O leaves completed on a to-do: reopen',
    todo({ baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-review' }, orca: 'in-progress', bc: 'completed' }),
    { baseline: { orca: 'in-progress', bc: 'open', lastOpenOrca: 'in-progress' }, writeBc: 'open' }
  ],
  [
    'only O changes between open statuses on a to-do: nothing to write',
    todo({ baseline: { orca: 'in-progress', bc: 'open', lastOpenOrca: 'in-progress' }, orca: 'in-review', bc: 'open' }),
    { baseline: { orca: 'in-review', bc: 'open', lastOpenOrca: 'in-review' } }
  ],
  [
    'O unmapped (custom) on a card: ignored, baseline follows',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'my-custom', bc: '9' }),
    { baseline: { orca: 'my-custom', bc: '9', lastOpenOrca: 'my-custom' } }
  ],
  [
    'leaving completed to an unmapped status leaves the card in place',
    card({ baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-review' }, orca: 'my-custom', bc: 'completed' }),
    { baseline: { orca: 'my-custom', bc: 'completed', lastOpenOrca: 'my-custom' } }
  ],
  // --- only Basecamp changed ---
  [
    'only B (mapped column): set the first status mapped to it',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'in-review', bc: '8' }),
    { baseline: { orca: 'todo', bc: '8', lastOpenOrca: 'todo' }, writeOrca: 'todo' }
  ],
  [
    'only B completed (card): Orca completed',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'in-review', bc: 'completed' }),
    { baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-review' }, writeOrca: 'completed' }
  ],
  [
    'only B completed (to-do): Orca completed',
    todo({ baseline: { orca: 'in-review', bc: 'open', lastOpenOrca: 'in-review' }, orca: 'in-review', bc: 'completed' }),
    { baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-review' }, writeOrca: 'completed' }
  ],
  [
    'reopen via lastOpenOrca restores the previous status',
    todo({ baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-review' }, orca: 'completed', bc: 'open' }),
    { baseline: { orca: 'in-review', bc: 'open', lastOpenOrca: 'in-review' }, writeOrca: 'in-review' }
  ],
  [
    'reopen without lastOpenOrca falls back to in-progress',
    todo({ baseline: { orca: 'completed', bc: 'completed' }, orca: 'completed', bc: 'open' }),
    { baseline: { orca: 'in-progress', bc: 'open', lastOpenOrca: 'in-progress' }, writeOrca: 'in-progress' }
  ],
  [
    'O unmapped and B moves to a mapped column: Basecamp wins silently, no conflict',
    card({ baseline: { orca: 'my-custom', bc: '9', lastOpenOrca: 'my-custom' }, orca: 'my-custom', bc: '8' }),
    { baseline: { orca: 'todo', bc: '8', lastOpenOrca: 'todo' }, writeOrca: 'todo' }
  ],
  [
    'B moves to an unmapped column: Orca unchanged',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'in-review', bc: '77' }),
    { baseline: { orca: 'in-review', bc: '77', lastOpenOrca: 'in-review' } }
  ],
  [
    'many-to-one: B moves to the column the current O already maps to, O is kept',
    card({ baseline: { orca: 'in-progress', bc: '9', lastOpenOrca: 'in-progress' }, orca: 'in-progress', bc: '8' }),
    { baseline: { orca: 'in-progress', bc: '8', lastOpenOrca: 'in-progress' } }
  ],
  // --- both changed ---
  [
    'both changed and convergent: no write, no conflict',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'in-progress', bc: '8' }),
    { baseline: { orca: 'in-progress', bc: '8', lastOpenOrca: 'in-progress' } }
  ],
  [
    'both changed to completed on a to-do: convergent',
    todo({ baseline: { orca: 'in-progress', bc: 'open', lastOpenOrca: 'in-progress' }, orca: 'completed', bc: 'completed' }),
    { baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-progress' } }
  ],
  [
    'both disagree, orca-wins: write Basecamp, conflict reported',
    card({ baseline: { orca: 'in-progress', bc: '8', lastOpenOrca: 'in-progress' }, orca: 'in-review', bc: 'completed' }),
    {
      baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' },
      writeBc: '9',
      conflict: { winner: 'orca', orca: 'in-review', bc: 'completed' }
    }
  ],
  [
    'both disagree, basecamp-wins: write Orca, conflict reported',
    card({
      rule: 'basecamp-wins',
      baseline: { orca: 'in-progress', bc: '8', lastOpenOrca: 'in-progress' },
      orca: 'in-review',
      bc: 'completed'
    }),
    {
      baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-progress' },
      writeOrca: 'completed',
      conflict: { winner: 'basecamp', orca: 'in-review', bc: 'completed' }
    }
  ],
  [
    'to-do conflict, orca-wins: O reopened, B completed -> uncomplete',
    todo({ baseline: { orca: 'completed', bc: 'open', lastOpenOrca: 'in-review' }, orca: 'in-progress', bc: 'completed' }),
    {
      baseline: { orca: 'in-progress', bc: 'open', lastOpenOrca: 'in-progress' },
      writeBc: 'open',
      conflict: { winner: 'orca', orca: 'in-progress', bc: 'completed' }
    }
  ],
  [
    'to-do conflict, basecamp-wins: B completed overrides Orca',
    todo({
      rule: 'basecamp-wins',
      baseline: { orca: 'in-review', bc: 'open', lastOpenOrca: 'in-review' },
      orca: 'in-progress',
      bc: 'completed'
    }),
    {
      baseline: { orca: 'completed', bc: 'completed', lastOpenOrca: 'in-review' },
      writeOrca: 'completed',
      conflict: { winner: 'basecamp', orca: 'in-progress', bc: 'completed' }
    }
  ]
];

for (const [name, input, expected] of rows) {
  test(`reconcile: ${name}`, () => {
    assert.deepEqual(reconcile(input), expected);
  });
}

test('no echo: feeding the resulting baseline and the written values back produces no write', () => {
  const first = reconcile(card({ baseline: { orca: 'in-progress', bc: '8', lastOpenOrca: 'in-progress' }, orca: 'in-review', bc: '8' }));
  assert.equal(first.writeBc, '9');
  const second = reconcile(card({ baseline: first.baseline, orca: 'in-review', bc: first.writeBc }));
  assert.deepEqual(second, { baseline: first.baseline });

  const toOrca = reconcile(todo({ baseline: { orca: 'in-review', bc: 'open', lastOpenOrca: 'in-review' }, orca: 'in-review', bc: 'completed' }));
  const again = reconcile(todo({ baseline: toOrca.baseline, orca: toOrca.writeOrca, bc: 'completed' }));
  assert.deepEqual(again, { baseline: toOrca.baseline });
});

test('a status literally named like an Object prototype key is treated as unmapped', () => {
  const r = reconcile(card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'constructor', bc: '9' }));
  assert.equal(r.writeBc, undefined);
  assert.equal(r.baseline.orca, 'constructor');
});

// ---- several columns per status (MAP.todo = ['8', '12']; '12' is "Por corregir") ----

const rowsMulti = [
  [
    'O -> todo while the card sits in the 2nd todo column: no move, baseline records the new O',
    card({ baseline: { orca: 'in-review', bc: '12', lastOpenOrca: 'in-review' }, orca: 'todo', bc: '12' }),
    { baseline: { orca: 'todo', bc: '12', lastOpenOrca: 'todo' } }
  ],
  [
    'O -> todo while the card sits in an unrelated column: move to the first todo column',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'todo', bc: '9' }),
    { baseline: { orca: 'todo', bc: '8', lastOpenOrca: 'todo' }, writeBc: '8' }
  ],
  [
    'card moves into the 2nd todo column while O=in-review: O becomes todo',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'in-review', bc: '12' }),
    { baseline: { orca: 'todo', bc: '12', lastOpenOrca: 'todo' }, writeOrca: 'todo' }
  ],
  [
    'card moves into the 2nd todo column while O=todo: no write',
    card({ baseline: { orca: 'todo', bc: '8', lastOpenOrca: 'todo' }, orca: 'todo', bc: '12' }),
    { baseline: { orca: 'todo', bc: '12', lastOpenOrca: 'todo' } }
  ],
  [
    'a column shared by two statuses keeps the current status',
    card({ baseline: { orca: 'in-progress', bc: '9', lastOpenOrca: 'in-progress' }, orca: 'in-progress', bc: '8' }),
    { baseline: { orca: 'in-progress', bc: '8', lastOpenOrca: 'in-progress' } }
  ],
  [
    'both changed and the card already sits in a column of the new O: convergent, no write',
    card({ baseline: { orca: 'in-review', bc: '9', lastOpenOrca: 'in-review' }, orca: 'todo', bc: '12' }),
    { baseline: { orca: 'todo', bc: '12', lastOpenOrca: 'todo' } }
  ]
];

for (const [name, input, expected] of rowsMulti) {
  test(`reconcile: ${name}`, () => {
    assert.deepEqual(reconcile(input), expected);
  });
}
