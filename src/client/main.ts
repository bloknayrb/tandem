import { mount } from "svelte";
import Root from "./Root.svelte";
import "./actions/scroll-fade.css";

mount(Root, { target: document.getElementById("root")! });
