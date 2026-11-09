import { HashIcon, type DefinedIcon } from "./design-system/icons/index";
import styles from "./InlineReference.module.css";

/** Classes for the icon leading a channel's name: a hash sits flush, as part
 * of the name, and any other icon keeps a small gap. */
export function channelIconClass(Icon: DefinedIcon) {
  return `${styles.icon} ${Icon === HashIcon ? styles.flush : styles.snug}`;
}
