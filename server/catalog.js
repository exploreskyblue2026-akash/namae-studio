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
  ]},
  { id: 'realword', label: 'Real word', color: '#2FBF71', pool: [
    ['Bloom', 'A real word for things opening up and growing.'],
    ['Nimbus', 'A real word for a glowing cloud of light.'],
    ['Haven', 'A real word for a safe, welcoming place.'],
    ['Kindred', 'A real word for feeling closely connected.']
  ]},
  { id: 'descriptive', label: 'Descriptive', color: '#2E8BFF', pool: [
    ['QuickCraft', 'Says plainly what it is: fast, hands-on making.'],
    ['TrueMake', 'Says plainly what it is: honest, well-made things.'],
    ['EasyShelf', 'Says plainly what it is: simple to store and use.'],
    ['FreshStudio', 'Says plainly what it is: a new, lively workspace.']
  ]},
  { id: 'founder', label: 'Founder-style', color: '#FF6B6B', pool: [
    ["Mira & Co.", 'A personal name paired with "& Co." for a classic, trusted feel.'],
    ['House of Aro', 'A personal or invented name framed as a "house," like a design studio.'],
    ["Theo's Workshop", "A first name plus what it does, warm and personal."],
    ['Nora Lane', 'A name that reads like a person, grounded and approachable.']
  ]},
  { id: 'playful', label: 'Playful', color: '#FFB23E', pool: [
    ['Wobblebee', 'A silly, bouncy sound that is hard not to smile at.'],
    ['Snugmuffin', 'Cozy and a little absurd, built to be memorable.'],
    ['Doodlehop', 'Sounds like movement and drawing at once, light and fun.'],
    ['Puddlejump', 'An everyday playful image turned into a brand word.']
  ]},
  { id: 'minimal', label: 'Minimalist', color: '#4B4B4B', pool: [
    ['Orin', 'One clean, short, invented syllable with no clutter.'],
    ['Vael', 'A short, calm-sounding word that stays out of its own way.'],
    ['Juno', 'Short, familiar-sounding, easy to say in any language.'],
    ['Riso', 'A crisp two-syllable word with a clean, modern edge.']
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
  research_title: 'Availability check',
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
