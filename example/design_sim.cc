#include "design.h"
#include <cxxrtl/cxxrtl_vcd.h>
#include <cxxrtl/cxxrtl_time.h>
#include <cxxrtl/cxxrtl_replay.h>
#include <cxxrtl/cxxrtl_server.h>

using namespace cxxrtl::time_literals;

int main(int argc, char **argv) {
  if (argc != 1) {
    fprintf(stderr, "Usage: %s\n", argv[0]);
    return 1;
  }

  cxxrtl_design::p_top top;
  cxxrtl::agent<cxxrtl_design::p_top> agent(cxxrtl::spool("spool.bin"), top, "top ");

  std::string uri = agent.start_debugging(cxxrtl::tcp_link());
  fprintf(stderr, "Simulation started on %s\n", uri.c_str());

  agent.step();

  size_t cycles = 0;
  do {
    agent.advance(1_ns);
    top.p_clk.set(false);
    agent.step();

    agent.advance(1_ns);
    top.p_clk.set(true);
    agent.step();

    if (cycles == 3)
      agent.breakpoint(CXXRTL_LOCATION);
  } while (cycles++ < 1000);

  return 0;
}
