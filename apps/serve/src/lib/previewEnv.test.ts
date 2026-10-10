import { expect, test } from "bun:test";
import { previewProcessEnv } from "./previewEnv";

test("Vite trusts only the project's public hostname and receives no supervisor credentials", () => {
  const env = previewProcessEnv("abc", {
    PREVIEW_URL: "http://proj-abc.preview.example.test:8080",
    PATH: "/bin", SECRET_ACCESS_KEY: "secret", AIROUTER_API_KEY: "secret",
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".untrusted.test",
  });
  expect(env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe("proj-abc.preview.example.test");
  expect(env.PORT).toBe("3000");
  expect(env.PATH).toBe("/bin");
  expect(env.SECRET_ACCESS_KEY).toBeUndefined();
  expect(env.AIROUTER_API_KEY).toBeUndefined();
});

test("local previews derive the exact allowed hostname when PREVIEW_URL is absent", () => {
  expect(previewProcessEnv("abc", { PREVIEW_DOMAIN: "preview.localhost" })
    .__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe("proj-abc.preview.localhost");
});
