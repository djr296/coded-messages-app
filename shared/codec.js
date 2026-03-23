const alphabet = "abcdefghijklmnopqrstuvwxyz";
const map = {
  a: "q", b: "w", c: "e", d: "r", e: "t", f: "y", g: "u", h: "i", i: "o", j: "p",
  k: "a", l: "s", m: "d", n: "f", o: "g", p: "h", q: "j", r: "k", s: "l", t: "z",
  u: "x", v: "c", w: "v", x: "b", y: "n", z: "m"
};

const reverseMap = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));

function transform(input, dictionary) {
  return input
    .split("")
    .map((ch) => {
      const lower = ch.toLowerCase();
      if (!alphabet.includes(lower)) return ch;
      const converted = dictionary[lower] || lower;
      return ch === lower ? converted : converted.toUpperCase();
    })
    .join("");
}

function encode(text) {
  return transform(text, map);
}

function decode(text) {
  return transform(text, reverseMap);
}

module.exports = {
  encode,
  decode
};
