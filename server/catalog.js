'use strict';
// Shared catalog: directions, name pools and fixed option lists.

const dirs = [
  { id: 'phonetic', label: 'Phonetic fusion', color: '#006EFF', pool: [
    ['Lumora', 'Lumen (light) + aura: a glow around a space.'],
    ['Kindleo', 'Kindle + idea: a spark that becomes a thought.'],
    ['Velora', 'Velocity + aurora: bright, quick movement.'],
    ['Sunnova', 'Sun + nova: a burst of warm energy.']
  ]},
  { id: 'repetition', label: 'Repetition', color: '#FF3EA5', pool: [
    ['Tiktik', 'The steady tick of a clock; repeated, it becomes a rhythm.'],
    ['Bolo Bolo', 'A playful double beat that keeps going.'],
    ['Nana Nana', 'A soft, repeated call that feels friendly.'],
    ['Zigzig', 'Quick back-and-forth, playful and busy.']
  ]},
  { id: 'compound', label: 'Compound', color: '#FFD84D', pool: [
    ['Craftmere', 'Craft + mere (a calm lake): a calm place to make things.'],
    ['Hearthwell', 'Hearth + well: the warm place where ideas start.'],
    ['Makeshelf', 'Make + shelf: where finished things are kept.'],
    ['Workhaven', 'Work + haven: a safe place to make.']
  ]},
  { id: 'coined', label: 'Coined', color: '#7CC8F5', pool: [
    ['ARTORM', 'Art + storm: a burst of creative energy.'],
    ['Quilvo', 'Quill + vox: the voice of the maker.'],
    ['Maevin', 'Maker + vine: things that grow over time.'],
    ['Brimoka', 'Brim + moka: a full cup of making time.']
  ]},
  { id: 'metaphor', label: 'Metaphor', color: '#FF9A3D', pool: [
    ['Ember Loom', 'A warm thread of making.'],
    ['Paper Kite', 'Lifting ideas off the ground.'],
    ['Ink Lantern', 'Light for drawing and writing.'],
    ['Tin Sparrow', 'Small, light and hand-made.']
  ]},
  { id: 'borrowed', label: 'Borrowed', color: '#9B6BFF', pool: [
    ['Tsukuri', 'Japanese: to make, to build.'],
    ['Werkstatt', 'German: workshop.'],
    ['Taller', 'Spanish: workshop.'],
    ['Atelier', "French: an artist's studio."]
  ]}
];

const markets = [
  { id: 'domestic', label: 'Domestic' },
  { id: 'international', label: 'International' },
  { id: 'both', label: 'Both' }
];
const classes = ['Education', 'Events', 'Consumer goods', 'Software', 'Food & drink', 'Art & media'];
const segments = ['Mothers', 'Home bakers', 'Artists', 'Kids', 'Hobbyists', 'Makers'];
const params = [
  { id: 'sound', label: 'Sound & feel' },
  { id: 'origin', label: 'Origin & meaning' },
  { id: 'similar', label: 'Similar brands' },
  { id: 'domain', label: 'Domain' },
  { id: 'trademark', label: 'Trademark' },
  { id: 'social', label: 'Social' }
];
const ELEMENTS = ['Worm', 'Ora', 'Lum', 'Quill', 'Bloom', 'Tik', 'Nest', 'Spark'];

const UI_DEFAULT = {
  brief_title: 'Tell us about the business',
  brief_ph: 'Describe the business in your own words',
  understand: 'Understand',
  confirm: 'Confirm',
  directions_title: 'Directions',
  names_title: 'Names',
  shortlist_title: 'Shortlist',
  library_title: 'Library',
  account_title: 'Account',
  keep: 'Keep',
  shortlist_btn: 'Shortlist',
  lock: 'Lock',
  reject: 'Reject',
  reshuffle: 'Reshuffle',
  more: 'Generate more'
};

// Similar forms: swap, shift or insert a letter, like ARTORM -> AROTRM or ARTMOR.
function similarVariants(name, k = 4) {
  const base = name.toUpperCase().replace(/\s+/g, '');
  const out = new Set();
  let tries = 0;
  while (out.size < k && tries < 100 && base.length >= 4) {
    tries++;
    const arr = base.split('');
    const i = 1 + Math.floor(Math.random() * (arr.length - 3));
    const op = Math.random();
    if (op < 0.4) { [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; }
    else if (op < 0.7) {
      const c = arr.splice(i, 1)[0];
      arr.splice(Math.min(arr.length, i + 1 + Math.floor(Math.random() * 2)), 0, c);
    } else {
      arr.splice(i, 0, ['W', 'L', 'N', 'Y', 'R'][Math.floor(Math.random() * 5)]);
    }
    const v = arr.join('');
    if (v !== base) out.add(v);
  }
  return [...out].slice(0, k);
}

// New element: keep the first four letters, add an element, like ARTO + WORM.
function newElementVariants(name, k = 3) {
  const base = name.toUpperCase().replace(/\s+/g, '').slice(0, 4);
  return [...ELEMENTS].sort(() => Math.random() - 0.5).slice(0, k).map(e => base + e.toUpperCase());
}

const pub = { dirs, markets, classes, segments, params };

module.exports = { dirs, markets, classes, segments, params, ELEMENTS, UI_DEFAULT, similarVariants, newElementVariants, pub };
