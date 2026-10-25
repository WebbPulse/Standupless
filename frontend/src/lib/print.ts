/**
 * Printing a document, an issue or a project overview: the browser's own
 * print dialog over the print stylesheet, so a PDF is saved client side with
 * nothing rendered on a server. Closed read-mode sections open for the print
 * and close again after it, since a collapsed section should print in full.
 */

/** The keys that print the page in view, as Cmd or Ctrl+P does in a browser. */
export const PRINT_KEYS = 'mod+p';

/** The command's name in menus and the palette. */
export const PRINT_LABEL = 'Print';

/** The attribute that marks a section opened only for the print. */
const OPENED_FOR_PRINT = 'data-opened-for-print';

/** Opens every closed `<details>` under a root and marks it to close later. */
export const openSectionsForPrint = (root: ParentNode = document): void => {
  root.querySelectorAll('details:not([open])').forEach((section) => {
    section.setAttribute(OPENED_FOR_PRINT, '');
    section.setAttribute('open', '');
  });
};

/** Closes the sections {@link openSectionsForPrint} opened. */
export const restoreSectionsAfterPrint = (
  root: ParentNode = document
): void => {
  root.querySelectorAll(`details[${OPENED_FOR_PRINT}]`).forEach((section) => {
    section.removeAttribute(OPENED_FOR_PRINT);
    section.removeAttribute('open');
  });
};

/**
 * Listens for the browser starting and finishing a print, however it was
 * started, and returns the function that stops listening.
 */
export const installPrintExpansion = (
  target: Window = window
): (() => void) => {
  const before = (): void => {
    openSectionsForPrint(target.document);
  };
  const after = (): void => {
    restoreSectionsAfterPrint(target.document);
  };
  target.addEventListener('beforeprint', before);
  target.addEventListener('afterprint', after);
  return () => {
    target.removeEventListener('beforeprint', before);
    target.removeEventListener('afterprint', after);
  };
};

/** Opens the browser's print dialog for the page in view. */
export const printPage = (): void => {
  window.print();
};
