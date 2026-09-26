/**
 * What reading an attr off the markup needs of an element, typed without the
 * DOM so the schema can be built where there is none (FF-1791).
 */
export type MarkupElement = { getAttribute(name: string): string | null };
