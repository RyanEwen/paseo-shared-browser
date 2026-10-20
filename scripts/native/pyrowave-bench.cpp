// Shared Browser development benchmark. See LICENSE for this repository's license.
// Uses the pinned MIT PyroWave C API; not part of the installed plugin runtime.
#include <vulkan/vulkan.h>
#include <pyrowave.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using Clock = std::chrono::steady_clock;
static constexpr size_t MaxFrameBytes = 2 * 1024 * 1024;
static void checked(pyrowave_result result) {
  if (result != PYROWAVE_SUCCESS) throw std::runtime_error("PyroWave error " + std::to_string(result));
}
static uint32_t number(const char *value, int base = 10) {
  const std::string input(value);
  if (input.empty() || input[0] == '-') throw std::runtime_error("Invalid positive argument");
  size_t consumed = 0;
  const auto parsed = std::stoul(input, &consumed, base);
  if (consumed != input.size() || parsed > UINT32_MAX) throw std::runtime_error("Invalid integer argument");
  return uint32_t(parsed);
}
static double elapsed(Clock::time_point start, Clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}
static double percentile(std::vector<double> values, double quantile) {
  std::sort(values.begin(), values.end());
  return values.at(size_t(std::ceil(quantile * values.size())) - 1);
}
static void write_bytes(const std::filesystem::path &path, const std::vector<uint8_t> &data, size_t size) {
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  file.write(reinterpret_cast<const char *>(data.data()), std::streamsize(size));
  if (!file) throw std::runtime_error("Cannot write benchmark fixture");
}
static pyrowave_cpu_buffer buffer(std::vector<uint8_t> &data, int width, int height) {
  pyrowave_cpu_buffer result = {};
  const size_t luma = size_t(width) * height;
  result.data[0] = data.data(); result.data[1] = data.data() + luma; result.data[2] = data.data() + luma * 5 / 4;
  result.row_stride_in_bytes[0] = width;
  result.row_stride_in_bytes[1] = result.row_stride_in_bytes[2] = width / 2;
  result.plane_size_in_bytes[0] = luma;
  result.plane_size_in_bytes[1] = result.plane_size_in_bytes[2] = luma / 4;
  result.width = width; result.height = height; result.format = PYROWAVE_CPU_BUFFER_FORMAT_YUV420P;
  return result;
}
struct DeviceDrop { void operator()(pyrowave_device d) const { pyrowave_device_destroy(d); } };
struct EncoderDrop { void operator()(pyrowave_encoder e) const { pyrowave_encoder_destroy(e); } };
struct DecoderDrop { void operator()(pyrowave_decoder d) const { pyrowave_decoder_destroy(d); } };

int main(int argc, char **argv) {
  try {
    if (argc != 9 && argc != 10) throw std::runtime_error("Usage: pyrowave-bench WIDTH HEIGHT FPS MBPS FRAMES VENDOR_HEX DEVICE_HEX OUTPUT_DIRECTORY [INPUT_I420]");
    const int width = int(number(argv[1])), height = int(number(argv[2]));
    const unsigned fps = number(argv[3]), mbps = number(argv[4]), frames = number(argv[5]);
    const uint32_t vendor = number(argv[6],16), product = number(argv[7],16);
    if (width < 64 || height < 64 || width > 3840 || height > 3840 || (width & 1) || (height & 1) ||
        (fps != 30 && fps != 60) || mbps < 10 || mbps > 250 || frames < 20 || frames > 600 || !vendor || !product)
      throw std::runtime_error("Arguments exceed benchmark bounds");
    const size_t input_size = size_t(width) * height * 3 / 2;
    if (argc == 10 && std::filesystem::file_size(argv[9]) != input_size)
      throw std::runtime_error("Input must contain exactly one bounded I420 frame");
    const std::filesystem::path directory(argv[8]);
    if (!std::filesystem::create_directory(directory)) throw std::runtime_error("Output directory must be new (never overwrite a previous run)");
    uint32_t major, minor, patch;
    pyrowave_get_api_version(&major,&minor,&patch);
    if (major != 1 || minor != 0 || patch != 0) throw std::runtime_error("Expected pinned PyroWave C API 1.0.0");
    pyrowave_device raw_device = nullptr;
    checked(pyrowave_create_device_by_compat(vendor, product, nullptr, nullptr, nullptr, VK_QUEUE_GLOBAL_PRIORITY_MEDIUM, &raw_device));
    std::unique_ptr<pyrowave_device_opaque,DeviceDrop> device(raw_device);
    pyrowave_encoder_create_info encoder_info = {device.get(),width,height,PYROWAVE_CHROMA_SUBSAMPLING_420};
    pyrowave_decoder_create_info decoder_info = {device.get(),width,height,PYROWAVE_CHROMA_SUBSAMPLING_420,false};
    pyrowave_encoder raw_encoder = nullptr; pyrowave_decoder raw_decoder = nullptr;
    checked(pyrowave_encoder_create(&encoder_info,&raw_encoder));
    std::unique_ptr<pyrowave_encoder_opaque,EncoderDrop> encoder(raw_encoder);
    checked(pyrowave_decoder_create(&decoder_info,&raw_decoder));
    std::unique_ptr<pyrowave_decoder_opaque,DecoderDrop> decoder(raw_decoder);
    const size_t pixels = size_t(width) * height;
    std::vector<uint8_t> input(pixels * 3 / 2), output(input.size()), bitstream(MaxFrameBytes);
    if (argc == 10) {
      std::ifstream file(argv[9], std::ios::binary);
      file.read(reinterpret_cast<char *>(input.data()), std::streamsize(input.size()));
      if (!file) throw std::runtime_error("Cannot read complete I420 input");
    }
    auto source = buffer(input,width,height), destination = buffer(output,width,height);
    const pyrowave_rate_control rate = {size_t(mbps) * 1000000 / (8 * fps)};
    std::vector<double> submit_ms, encode_wait_ms, packetize_ms, decode_readback_ms, emitted_bytes;
    double squared_error = 0;
    // Unpaced serialized bring-up path, not a streaming-throughput or end-to-end latency test.
    for (unsigned frame = 0; frame < frames + 8; ++frame) {
      if (argc == 9) {
      for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        int value = (x * 219 / width + y * 37 / height) % 220 + 16;
        if (y < height / 4) value = (x & 1) ? 235 : 16;
        if (y >= height / 4 && y < height / 2) value = ((x / 3 + y / 3) & 1) ? 220 : 30;
        if (x >= int(frame * 7 % unsigned(width - 32)) && x < int(frame * 7 % unsigned(width - 32)) + 32 && y > height / 2) value = 235;
        input[size_t(y) * width + x] = uint8_t(value);
      }
      for (size_t i = pixels; i < input.size(); ++i) input[i] = uint8_t(96 + ((i + frame) % 64));
      }
      const auto start = Clock::now();
      checked(pyrowave_encoder_encode_cpu(encoder.get(),&source,&rate));
      const auto submitted = Clock::now();
      size_t count = 0;
      checked(pyrowave_encoder_compute_num_packets(encoder.get(),65536,&count));
      const auto ready = Clock::now();
      if (!count || count > 128) throw std::runtime_error("Packet count exceeds benchmark bound");
      std::vector<pyrowave_packet> packets(count);
      checked(pyrowave_encoder_packetize(encoder.get(),packets.data(),65536,&count,bitstream.data(),bitstream.size()));
      const auto packetized = Clock::now();
      if (!count || count > packets.size()) throw std::runtime_error("Invalid packet count");
      size_t bytes = 0, extent = 0;
      pyrowave_decoder_clear(decoder.get());
      for (size_t i = 0; i < count; ++i) {
        const auto &packet = packets[i];
        if (!packet.size || packet.offset > bitstream.size() || packet.size > bitstream.size() - packet.offset || packet.size > 65536)
          throw std::runtime_error("Packet exceeds benchmark bound");
        bytes += packet.size; extent = std::max(extent,packet.offset + packet.size);
        checked(pyrowave_decoder_push_packet(decoder.get(),bitstream.data() + packet.offset,packet.size));
      }
      if (!pyrowave_decoder_decode_is_ready(decoder.get(),false)) throw std::runtime_error("Incomplete native frame");
      checked(pyrowave_decoder_decode_cpu_buffer_synchronous(decoder.get(),&destination));
      const auto decoded = Clock::now();
      if (frame >= 8) {
        submit_ms.push_back(elapsed(start,submitted)); encode_wait_ms.push_back(elapsed(start,ready));
        packetize_ms.push_back(elapsed(ready,packetized)); decode_readback_ms.push_back(elapsed(packetized,decoded)); emitted_bytes.push_back(double(bytes));
        for (size_t i = 0; i < pixels; ++i) { const double error = double(input[i]) - output[i]; squared_error += error * error; }
      }
      if (frame == 8) {
        write_bytes(directory/"source.i420",input,input.size());
        write_bytes(directory/"decoded.i420",output,output.size());
        write_bytes(directory/"frame.bin",bitstream,extent);
        std::ofstream manifest(directory/"manifest.json");
        manifest << "{\"width\":" << width << ",\"height\":" << height << ",\"chroma\":\"420\",\"format\":\"I420\",\"packets\":[";
        for (size_t i = 0; i < count; ++i) {if(i)manifest << ',';manifest << "{\"offset\":" << packets[i].offset << ",\"size\":" << packets[i].size << '}';}
        manifest << "]}\n";
        if (!manifest) throw std::runtime_error("Cannot write packet manifest");
      }
    }
    const auto summary = [](const char *name,const std::vector<double> &values) {
      std::cout << '"' << name << "\":{\"p50\":" << percentile(values,.5) << ",\"p95\":" << percentile(values,.95) << '}';
    };
    std::cout << "{\"pyrowaveCommit\":\"21f099d24df0ab0e4c10c3288c924b6b1717e581\",\"api\":\"1.0.0\",\"width\":" << width << ",\"height\":" << height << ",\"budgetFps\":" << fps << ",\"budgetMbps\":" << mbps << ",\"measuredFrames\":" << frames << ",\"warmupFrames\":8,\"targetBitstreamBytes\":" << rate.maximum_bitstream_size << ",\"unpacedSerializedCpuBufferPath\":true,";
    summary("hostEncodeSubmitMs",submit_ms);std::cout << ',';
    summary("hostEncodeIncludingWaitMs",encode_wait_ms);std::cout << ',';
    summary("packetizeMs",packetize_ms);std::cout << ',';
    summary("nativeDecodeIncludingReadbackMs",decode_readback_ms);std::cout << ',';
    summary("emittedPacketBytes",emitted_bytes);
    const double mse = squared_error / double(pixels * frames);
    std::cout << ",\"lumaPsnrDb\":" << (mse > 0 ? std::to_string(10 * std::log10(255.0 * 255.0 / mse)) : "null") << ",\"browserNetworkOrPresentationMeasured\":false}\n";
    pyrowave_device_report_performance_stats(device.get(),[](void *,const char *message) {std::cerr << std::string(message).substr(0,512) << '\n';},nullptr,true);
    return 0;
  } catch (const std::exception &error) {std::cerr << error.what() << '\n';return 1;}
}
