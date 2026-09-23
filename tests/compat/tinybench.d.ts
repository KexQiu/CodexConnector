// tinybench 6.1.4 references this DOM typedef in its Node benchmark declarations.
// Keep the numeric alias in tests instead of exposing the entire DOM API to production.
export {};
declare global {
  type DOMHighResTimeStamp = number;
}
