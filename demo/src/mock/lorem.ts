/** Markdown Lorem ipsum for simulated answers: paragraphs, sometimes a list and bold text. */

const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut ' +
  'labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris ' +
  'nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse ' +
  'cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui ' +
  'officia deserunt mollit anim id est laborum curabitur pretium tincidunt lacus nulla gravida ' +
  'orci a odio nullam varius turpis et commodo pharetra est eros bibendum elit nec luctus magna ' +
  'felis sollicitudin mauris integer in mauris eu nibh euismod gravida'
).split(' ');

type Random = () => number;

const int = (random: Random, min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));

const pick = (random: Random) => WORDS[int(random, 0, WORDS.length - 1)] ?? 'lorem';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function sentence(random: Random, min = 6, max = 16): string {
  const words = Array.from({ length: int(random, min, max) }, () => pick(random));
  if (words.length > 5 && random() < 0.25) {
    const at = int(random, 1, words.length - 3);
    words[at] = `**${words[at]} ${words[at + 1]}**`;
    words.splice(at + 1, 1);
  }
  if (words.length > 8 && random() < 0.3) {
    const at = int(random, 3, words.length - 3);
    words[at] = `${words[at]},`;
  }
  return `${capitalize(words.join(' '))}.`;
}

const paragraph = (random: Random) =>
  Array.from({ length: int(random, 2, 5) }, () => sentence(random)).join(' ');

const list = (random: Random) =>
  Array.from({ length: int(random, 3, 4) }, () => `- ${sentence(random, 3, 8)}`).join('\n');

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** An answer of about 80–250 words. `random` makes it reproducible in tests. */
export function loremAnswer(random: Random = Math.random): string {
  const target = int(random, 80, 250);
  const blocks: string[] = [];
  let listed = false;
  while (wordCount(blocks.join(' ')) < target) {
    if (!listed && blocks.length >= 1 && random() < 0.4) {
      blocks.push(list(random));
      listed = true;
    } else {
      blocks.push(paragraph(random));
    }
  }
  return blocks.join('\n\n');
}

/** Stream tokens: words with their trailing whitespace (concatenated they give `text`). */
export function streamTokens(text: string): string[] {
  return text.match(/\s*\S+\s*/g) ?? [];
}
