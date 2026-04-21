import { Injectable } from "@nestjs/common";
import axios from "axios";
import * as crypto from "crypto";
import { EnvConfig } from "../common/config/env.config";

@Injectable()
export class ShoplazzaService {
  constructor(private readonly env: EnvConfig) {}

  verifyWebhookSignature(rawBody: Buffer, providedHmac?: string): boolean {
    if (!providedHmac || !rawBody) return false;
    const digest = crypto
      .createHmac("sha256", this.env.shoplazza.webhookSecret)
      .update(rawBody)
      .digest("base64");
    const received = Buffer.from(providedHmac, "utf8");
    const expected = Buffer.from(digest, "utf8");
    if (received.length !== expected.length) return false;
    return crypto.timingSafeEqual(received, expected);
  }

  async cancelOrder(orderId: string | number, reason = "fraud"): Promise<void> {
    await this.client.post(this.path(this.env.shoplazza.cancelOrderPathTemplate, orderId), { reason });
  }

  async appendOrderNote(orderId: string | number, note: string): Promise<void> {
    await this.client.put(this.path(this.env.shoplazza.updateOrderPathTemplate, orderId), {
      order: { id: orderId, note }
    });
  }

  private get client() {
    return axios.create({
      baseURL: `https://${this.env.shoplazza.storeDomain}`,
      timeout: this.env.shoplazza.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "X-Shoplazza-Access-Token": this.env.shoplazza.adminToken
      }
    });
  }

  private path(template: string, orderId: string | number): string {
    return template.replace("{orderId}", encodeURIComponent(String(orderId)));
  }
}
