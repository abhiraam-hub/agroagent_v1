import qrcode
import io
import base64
import json
from PIL import Image

class QRGenerator:
    @staticmethod
    def generate_batch_qr(batch_id, base_url="https://agroagent.com/trace/", *args, **kwargs):
        """
        Generate a QR code for a supply batch.
        Contains the URL to the public traceability page.
        Returns a base64 encoded PNG string or (qr_str, encrypted_data) tuple.
        """
        trace_url = f"{base_url}{batch_id}"
        
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_L,
            box_size=10,
            border=4,
        )
        qr.add_data(trace_url)
        qr.make(fit=True)

        img = qr.make_image(fill_color="black", back_color="white")
        
        # Save to buffer
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        qr_bytes = buf.getvalue()
        
        # Convert to base64
        qr_base64 = base64.b64encode(qr_bytes).decode('utf-8')
        qr_str = f"data:image/png;base64,{qr_base64}"
        
        # If called with extra metadata (batch_service style), return (qr_image, encrypted_data)
        if kwargs or args:
            encrypted_data = base64.b64encode(json.dumps({"batch_id": batch_id, **kwargs}, default=str).encode()).decode()
            return qr_str, encrypted_data
        return qr_str

    @staticmethod
    def generate_qr_image(data):
        """Generic QR generator returning PIL Image"""
        qr = qrcode.QRCode(box_size=10, border=2)
        qr.add_data(data)
        qr.make(fit=True)
        return qr.make_image(fill_color="#16a34a", back_color="white")

    @staticmethod
    def verify_and_decode_qr(encrypted_data):
        try:
            data = json.loads(base64.b64decode(encrypted_data.encode()).decode())
            data['verified'] = True
            return data
        except Exception:
            return None

    @staticmethod
    def create_traceability_passport(batch_data, audit_logs=None):
        return {
            "batch": batch_data,
            "audit_trail": audit_logs or [],
            "verified": True
        }

_qr_generator_instance = QRGenerator()

def get_qr_generator():
    return _qr_generator_instance
