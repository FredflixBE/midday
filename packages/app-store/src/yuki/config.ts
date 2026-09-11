import { Logo } from "./assets/logo";

// No images, so this one file is safe on the server and in the dashboard.
export default {
  name: "Yuki",
  id: "yuki",
  category: "accounting",
  active: true,
  beta: true,
  logo: Logo,
  short_description:
    "Connect your Yuki administration, so Midday can read what your books already hold.",
  description:
    "Connect Midday with Yuki (Nmbrs Accounting) using an access key from Yuki's Settings > Web services.\n\n**One team, one administration**\nThe connection belongs to this team only. Another team sees nothing from Yuki until it connects an administration of its own.\n\n**Checked before it is saved**\nMidday checks the key with reads only, and shows the administration it reads before anything is saved. The key is stored encrypted.\n\n**Disconnect any time**\nDisconnecting removes the key. What Midday already read stays; nothing more is read.",
  images: [] as string[],
};
