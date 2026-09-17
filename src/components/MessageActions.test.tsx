import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { MessageActions } from "./MessageActions";
afterEach(cleanup);
function Harness() {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState(false);
  return <div style={{ transform: "translateZ(0)", overflow: "hidden" }} data-testid="clip">
    <div ref={anchor} tabIndex={0} onClick={() => setOpen(true)}>Message</div>
    {open && <MessageActions anchor={anchor} alignEnd={false} onClose={() => setOpen(false)}>
      <button onClick={() => { setReply(true); setOpen(false); }}>Reply</button><button>React</button>
    </MessageActions>}
    {reply && <input autoFocus aria-label="Reply text" />}
  </div>;
}
describe("message action ownership", () => {
  it("portals outside transformed/overflow-hidden messages and keeps the toolbar above its backdrop", () => {
    render(<Harness />); fireEvent.click(screen.getByText("Message"));
    const toolbar = screen.getByRole("toolbar");
    expect(screen.getByTestId("clip").contains(toolbar)).toBe(false);
    const layer = toolbar.parentElement!;
    expect(layer.parentElement).toBe(document.body);
    expect(layer.lastElementChild).toBe(toolbar);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
  it("focuses, cycles keyboard actions, closes with Escape and restores the anchor", () => {
    render(<Harness />); const anchor = screen.getByText("Message");
    anchor.focus(); fireEvent.click(anchor);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "React" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("toolbar")).toBeNull(); expect(document.activeElement).toBe(anchor);
  });
  it("clamps to a narrow viewport and cleans up viewport listeners when dismissed", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    render(<Harness />); fireEvent.click(screen.getByText("Message"));
    const toolbar=screen.getByRole("toolbar");
    expect(toolbar.style.left).toBe("12px"); expect(toolbar.style.top).toBe("12px");
    act(() => window.dispatchEvent(new Event("resize")));
    fireEvent.click(toolbar.previousElementSibling!);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function), true);
  });
});
