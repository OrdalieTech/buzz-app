import { Component, createRef } from "react";
import { Button } from "../shared/design-system/ui/Button";

type FocusTarget = { refresh: HTMLButtonElement; focusVisible: boolean };

export class TranscriptPreviewNotice extends Component<{
  partial: boolean;
  loading?: boolean;
  onLoad(): void;
}> {
  private load = createRef<HTMLButtonElement>();

  getSnapshotBeforeUpdate() {
    const button = this.load.current;
    if (
      this.props.partial ||
      !button ||
      button.ownerDocument.activeElement !== button
    )
      return null;
    const refresh = button
      .closest("[data-transcript]")
      ?.querySelector<HTMLButtonElement>(
        '[data-transcript-header] button[aria-label="Refresh transcript"]',
      );
    return refresh
      ? { refresh, focusVisible: button.matches(":focus-visible") }
      : null;
  }

  componentDidUpdate(
    _previous: unknown,
    _state: unknown,
    target?: FocusTarget | null,
  ) {
    if (
      target?.refresh.isConnected &&
      target.refresh.ownerDocument.activeElement ===
        target.refresh.ownerDocument.body
    ) {
      const options = {
        preventScroll: true,
        focusVisible: target.focusVisible,
      };
      target.refresh.focus(options);
    }
  }

  render() {
    if (!this.props.partial) return null;
    return (
      <div className="text-body-sm text-subtle">
        Earlier activity is not loaded.{" "}
        <Button
          ref={this.load}
          variant="plain"
          size="inline"
          loading={this.props.loading ?? false}
          onClick={this.props.onLoad}
        >
          Load earlier activity
        </Button>
      </div>
    );
  }
}
