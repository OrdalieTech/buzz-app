import { Popover } from "@base-ui/react/popover";
import { useState } from "react";
import { Calendar } from "../../shared/design-system/ui/Calendar";
import { FieldButton } from "../../shared/design-system/ui/FieldButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import styles from "./Status.module.css";

const times = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 ? "30" : "00";
  return {
    value: `${hour.toString().padStart(2, "0")}:${minute}`,
    label: `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`,
  };
});

export function StatusExpiration({
  value,
  onChange,
  disabled,
  label = "Status expiration",
}: {
  value: Date;
  onChange(value: Date): void;
  disabled: boolean;
  /** Names the date and time controls, e.g. "Focus end". */
  label?: string;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const time = `${value.getHours().toString().padStart(2, "0")}:${value.getMinutes().toString().padStart(2, "0")}`;
  return (
    <div className={styles.expiration}>
      <span className="text-label-sm text-subtle">Until</span>
      <div className={styles.expirationFields}>
        <Popover.Root open={calendarOpen} onOpenChange={setCalendarOpen}>
          <Popover.Trigger
            disabled={disabled}
            render={<FieldButton aria-label={`${label} date`} />}
          >
            {value.toLocaleDateString([], {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              sideOffset={4}
              align="start"
              collisionPadding={16}
              className={styles.calendarPositioner}
            >
              <Popover.Popup
                className={styles.calendarPopup}
                aria-label="Choose expiration date"
              >
                <Calendar
                  mode="single"
                  required
                  autoFocus
                  selected={value}
                  defaultMonth={value}
                  disabled={{ before: today }}
                  onSelect={(day) => {
                    const next = new Date(day);
                    next.setHours(
                      value.getHours(),
                      value.getMinutes(),
                      value.getSeconds(),
                      0,
                    );
                    onChange(next);
                    setCalendarOpen(false);
                  }}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <MenuRoot>
          <MenuTrigger
            disabled={disabled}
            render={<FieldButton aria-label={`${label} time`} />}
          >
            {times.find((option) => option.value === time)?.label ??
              value.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
          </MenuTrigger>
          <MenuPopup align="end" data-status-menu>
            <div className={styles.timeOptions}>
              <MenuRadioGroup
                value={time}
                aria-label="Expiration time"
                onValueChange={(timeValue) => {
                  const hour = Number(timeValue.slice(0, 2));
                  const minute = Number(timeValue.slice(3));
                  const next = new Date(value);
                  next.setHours(hour, minute, 0, 0);
                  onChange(next);
                }}
              >
                {times.map((option) => (
                  <MenuRadioItem
                    key={option.value}
                    value={option.value}
                    closeOnClick
                  >
                    {option.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </div>
          </MenuPopup>
        </MenuRoot>
      </div>
    </div>
  );
}
