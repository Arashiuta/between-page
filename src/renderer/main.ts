import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import LibraryView from "./views/LibraryView.vue";
import WorkspaceView from "./views/WorkspaceView.vue";
import CardsView from "./views/CardsView.vue";
import GalleryView from "./views/GalleryView.vue";
import SettingsView from "./views/SettingsView.vue";
import RolesView from "./views/RolesView.vue";
import { useWorkspace } from "./stores/workspace";
import "./styles.css";

const app = createApp(App),
  pinia = createPinia();
app.use(pinia);
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: LibraryView },
    { path: "/story/:id", component: WorkspaceView },
    { path: "/cards", component: CardsView },
    { path: "/gallery", component: GalleryView },
    { path: "/settings", component: SettingsView },
    { path: "/roles", component: RolesView },
  ],
});
router.beforeEach(async (to, from) => {
  const store = useWorkspace();
  if (to.fullPath !== from.fullPath && (store.busy || store.imageBusy)) {
    store.notify("请先停止或等待当前生成任务完成。", "info");
    return false;
  }
  try {
    await store.flush();
    return true;
  } catch (error) {
    store.notify("保存失败，请先重试保存再离开当前页面。", "error");
    return false;
  }
});
app.use(router);
app.mount("#app");
