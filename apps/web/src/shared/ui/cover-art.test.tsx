import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CoverArt } from "./primitives.js";

describe("CoverArt error recovery", () => {
  it("clears failed state when src changes from A(fail) -> B(ok) -> A and retries rendering A", () => {
    const { rerender } = render(<CoverArt src="https://p1.music.126.net/a.jpg" alt="封面" />);

    fireEvent.error(screen.getByRole("img", { name: "封面" }));
    expect(screen.queryByRole("img", { name: "封面" })).toBeNull();

    rerender(<CoverArt src="https://p1.music.126.net/b.jpg" alt="封面" />);
    expect(screen.getByRole("img", { name: "封面" }).getAttribute("src")).toBe(
      "https://p1.music.126.net/b.jpg",
    );

    rerender(<CoverArt src="https://p1.music.126.net/a.jpg" alt="封面" />);
    expect(screen.getByRole("img", { name: "封面" }).getAttribute("src")).toBe(
      "https://p1.music.126.net/a.jpg",
    );
  });
});
