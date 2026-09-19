import { redirect } from "next/navigation";

/** Products have their own page now (FF-1620). */
export default function Page() {
  redirect("/products");
}
