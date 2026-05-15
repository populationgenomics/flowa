/**
 * Vitest test-setup file.
 *
 * Registers the `@testing-library/jest-dom` matchers so `expect(el).toHaveTextContent(...)`
 * and similar DOM assertions work uniformly across all `.test.tsx` files.
 */

import "@testing-library/jest-dom/vitest";
