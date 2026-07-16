// Entry point. The crypto polyfill MUST come first — before any import that
// pulls in the protocol core — or node:crypto calls will throw in RN.
import "./src/polyfill";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
