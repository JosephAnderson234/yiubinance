/** Minúsculas, sin tildes, sin signos de pregunta o exclamación y con espacios simples. */
export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** ¿Aparece `word` como palabra completa en `text`? */
export const hasWord = (text: string, word: string) => ` ${normalize(text)} `.includes(` ${normalize(word)} `);
