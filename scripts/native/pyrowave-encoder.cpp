// Shared Browser native I420/NV12 encoder. See LICENSE for repository license.
// The pinned PyroWave library and its dependencies retain their original licenses.
#include <vulkan/vulkan.h>
#include <pyrowave.h>
#include <dlfcn.h>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr uint32_t RequestMagic = 0x31525750;  // PWR1, little endian.
constexpr uint32_t ReplyMagic = 0x31455750;    // PWE1, little endian.
constexpr size_t HeaderBytes = 32;
constexpr size_t MaxEncodedBytes = 2 * 1024 * 1024;
using Header = std::array<uint8_t, HeaderBytes>;

// Protocol integers are explicitly little endian on every build architecture.
uint32_t read_word(const Header &header, size_t offset) {
  return uint32_t(header[offset]) | uint32_t(header[offset + 1]) << 8 |
         uint32_t(header[offset + 2]) << 16 | uint32_t(header[offset + 3]) << 24;
}
void write_word(Header &header, size_t offset, uint32_t value) {
  for (size_t i = 0; i < 4; ++i) {
    header[offset + i] = uint8_t(value >> (i * 8));
  }
}
void checked(pyrowave_result result) {
  if (result != PYROWAVE_SUCCESS) {
    throw std::runtime_error("Native PyroWave operation failed");
  }
}
uint32_t argument(const char *value) {
  size_t consumed = 0;
  const std::string text(value);
  if (text.empty() || text[0] == '-') {
    throw std::runtime_error("Invalid encoder argument");
  }
  const auto parsed = std::stoul(text, &consumed, 10);
  if (consumed != text.size() || parsed > UINT32_MAX) {
    throw std::runtime_error("Invalid encoder argument");
  }
  return uint32_t(parsed);
}

struct DeviceDrop {
  void operator()(pyrowave_device value) const { pyrowave_device_destroy(value); }
};
struct EncoderDrop {
  void operator()(pyrowave_encoder value) const { pyrowave_encoder_destroy(value); }
};
using Device = std::unique_ptr<pyrowave_device_opaque, DeviceDrop>;
using Encoder = std::unique_ptr<pyrowave_encoder_opaque, EncoderDrop>;

// CPU drivers can expose the same Vulkan API. Refuse that substitution explicitly.
Device create_hardware_device() {
  uint32_t major = 0, minor = 0, patch = 0;
  pyrowave_get_api_version(&major, &minor, &patch);
  if (major != 1 || minor != 0 || patch != 0) {
    throw std::runtime_error("Unsupported PyroWave API version");
  }
  pyrowave_device raw = nullptr;
  checked(pyrowave_create_default_device(&raw));
  Device device(raw);

  void *loader = dlopen("libvulkan.so.1", RTLD_NOW | RTLD_LOCAL);
  if (!loader) {
    throw std::runtime_error("Vulkan loader unavailable");
  }
  auto properties_fn = reinterpret_cast<PFN_vkGetPhysicalDeviceProperties>(
      dlsym(loader, "vkGetPhysicalDeviceProperties"));
  if (!properties_fn) {
    dlclose(loader);
    throw std::runtime_error("Vulkan properties unavailable");
  }
  VkPhysicalDevice physical = VK_NULL_HANDLE;
  pyrowave_device_get_vk_device_handles(device.get(), nullptr, &physical, nullptr);
  VkPhysicalDeviceProperties properties = {};
  properties_fn(physical, &properties);
  dlclose(loader);
  if (properties.deviceType != VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU &&
      properties.deviceType != VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU &&
      properties.deviceType != VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU) {
    throw std::runtime_error("PyroWave requires a hardware GPU");
  }
  return device;
}

// One contiguous 8-bit native frame. The parent has already checked source geometry.
pyrowave_cpu_buffer cpu_buffer(std::vector<uint8_t> &bytes, int width, int height,
                               uint32_t format) {
  pyrowave_cpu_buffer buffer = {};
  const size_t pixels = size_t(width) * height;
  buffer.width = width;
  buffer.height = height;
  buffer.data[0] = bytes.data();
  buffer.data[1] = bytes.data() + pixels;
  buffer.row_stride_in_bytes[0] = width;
  buffer.plane_size_in_bytes[0] = pixels;
  if (format == 0) {
    buffer.format = PYROWAVE_CPU_BUFFER_FORMAT_NV12;
    buffer.row_stride_in_bytes[1] = width;
    buffer.plane_size_in_bytes[1] = pixels / 2;
  } else {
    buffer.format = PYROWAVE_CPU_BUFFER_FORMAT_YUV420P;
    buffer.data[2] = bytes.data() + pixels * 5 / 4;
    buffer.row_stride_in_bytes[1] = width / 2;
    buffer.row_stride_in_bytes[2] = width / 2;
    buffer.plane_size_in_bytes[1] = pixels / 4;
    buffer.plane_size_in_bytes[2] = pixels / 4;
  }
  return buffer;
}

// Packetization waits for GPU completion. All blocks form one bounded independent frame.
size_t encode_frame(pyrowave_encoder encoder, const pyrowave_cpu_buffer &input,
                    const pyrowave_rate_control &rate, std::vector<uint8_t> &output) {
  checked(pyrowave_encoder_encode_cpu(encoder, &input, &rate));
  size_t count = 0;
  checked(pyrowave_encoder_compute_num_packets(encoder, 65536, &count));
  if (count == 0 || count > 128) {
    throw std::runtime_error("Encoded packet count exceeded");
  }
  std::vector<pyrowave_packet> packets(count);
  checked(pyrowave_encoder_packetize(encoder, packets.data(), 65536, &count,
                                     output.data(), output.size()));
  if (count == 0 || count > packets.size()) {
    throw std::runtime_error("Invalid encoded packet count");
  }
  size_t extent = 0;
  for (size_t i = 0; i < count; ++i) {
    const auto &packet = packets[i];
    if (packet.offset != extent || packet.size == 0 || packet.size > 65536 ||
        packet.size > output.size() - extent) {
      throw std::runtime_error("Invalid encoded frame bounds");
    }
    extent += packet.size;
  }
  return extent;
}
}  // namespace

int main(int argc, char **argv) {
  try {
    if (argc != 5) {
      throw std::runtime_error("Usage: pyrowave-encoder WIDTH HEIGHT BITRATE FPS");
    }
    const uint32_t width = argument(argv[1]);
    const uint32_t height = argument(argv[2]);
    const uint32_t bitrate = argument(argv[3]);
    const uint32_t fps = argument(argv[4]);
    if (width < 64 || height < 64 || width > 3840 || height > 3840 ||
        (width & 1) || (height & 1) ||
        (bitrate != 100000000 && bitrate != 200000000 && bitrate != 250000000) ||
        (fps != 15 && fps != 30 && fps != 60)) {
      throw std::runtime_error("Unsupported native encoder configuration");
    }

    auto device = create_hardware_device();
    pyrowave_encoder_create_info info = {device.get(), int(width), int(height),
                                        PYROWAVE_CHROMA_SUBSAMPLING_420};
    pyrowave_encoder raw_encoder = nullptr;
    checked(pyrowave_encoder_create(&info, &raw_encoder));
    Encoder encoder(raw_encoder);
    const pyrowave_rate_control rate = {size_t(bitrate) / (8 * fps)};
    std::vector<uint8_t> input(size_t(width) * height * 3 / 2);
    std::vector<uint8_t> output(MaxEncodedBytes);
    uint32_t last_sequence = 0;

    while (true) {
      Header request = {};
      std::cin.read(reinterpret_cast<char *>(request.data()), request.size());
      if (std::cin.gcount() == 0 && std::cin.eof()) {
        return 0;
      }
      if (std::cin.gcount() != HeaderBytes || read_word(request, 0) != RequestMagic ||
          read_word(request, 4) != input.size() || read_word(request, 12) != 1 ||
          read_word(request, 8) <= last_sequence || read_word(request, 28) > 1) {
        throw std::runtime_error("Invalid raw frame header");
      }
      last_sequence = read_word(request, 8);
      std::cin.read(reinterpret_cast<char *>(input.data()), input.size());
      if (size_t(std::cin.gcount()) != input.size()) {
        throw std::runtime_error("Incomplete raw frame");
      }
      const auto frame = cpu_buffer(input, int(width), int(height), read_word(request, 28));
      const size_t length = encode_frame(encoder.get(), frame, rate, output);

      Header reply = request;
      write_word(reply, 0, ReplyMagic);
      write_word(reply, 4, uint32_t(length));
      std::cout.write(reinterpret_cast<const char *>(reply.data()), reply.size());
      std::cout.write(reinterpret_cast<const char *>(output.data()), length);
      std::cout.flush();
      if (!std::cout) {
        throw std::runtime_error("Native encoder output closed");
      }
    }
  } catch (const std::exception &error) {
    // Only fixed classifications are emitted; raw frames and credentials never reach logs.
    std::cerr << error.what() << '\n';
    return 1;
  }
}
