# -*- coding: utf-8 -*-
"""
Created on Mon Nov 10 12:58:55 2025

@author: 15hal
"""

import numpy as np
from newton_solve import newton_solve
import math

# -----------------------------
# Problem setup (you can tweak)
# -----------------------------
A = np.array([0.0, 0.0])      # left support r0
B = np.array([1.0, 0.0])      # right support r4
L = np.linalg.norm(B - A)     # horizontal span
N = 4                         # number of links
assert N == 4                 # this script is for 4 links / 3 interior nodes

total_length = 1.20 * L       # total chain length (> L)
s = total_length / N          # each link length
W = 1.0                       # weight per link (nondimensional scale)

# -----------------------------
# Utilities
# -----------------------------
def unpack_vars(v):
    """v = [x1,y1,x2,y2,x3,y3, T0,T1,T2,T3] -> positions r0..r4 and tensions T0..T3"""
    x1,y1,x2,y2,x3,y3, T0,T1,T2,T3 = v
    r0 = A
    r1 = np.array([x1,y1])
    r2 = np.array([x2,y2])
    r3 = np.array([x3,y3])
    r4 = B
    return (r0,r1,r2,r3,r4), np.array([T0,T1,T2,T3])

def unit(vec):
    n = np.linalg.norm(vec)
    if n == 0.0:
        return np.array([0.0, 0.0]), 0.0
    return vec/n, n

# -----------------------------
# Residual function F(v)
# -----------------------------
def F(v):
    (r0,r1,r2,r3,r4), T = unpack_vars(v)

    # Link vectors and unit directions
    e0, L0 = unit(r1 - r0)
    e1, L1 = unit(r2 - r1)
    e2, L2 = unit(r3 - r2)
    e3, L3 = unit(r4 - r3)

    # Length constraints: ||ri+1 - ri|| - s = 0
    c_len0 = L0 - s
    c_len1 = L1 - s
    c_len2 = L2 - s
    c_len3 = L3 - s

    # Force balance at interior nodes (j=1,2,3):
    # T_{j-1} * e_{j-1} - T_j * e_j + (0, -W) = 0
    fb1 = T[0]*e0 - T[1]*e1 + np.array([0.0, -W])
    fb2 = T[1]*e1 - T[2]*e2 + np.array([0.0, -W])
    fb3 = T[2]*e2 - T[3]*e3 + np.array([0.0, -W])

    # Stack residuals: 4 length + 3*2 force = 10 equations for 10 unknowns
    return np.array([
        c_len0, c_len1, c_len2, c_len3,
        fb1[0], fb1[1],
        fb2[0], fb2[1],
        fb3[0], fb3[1]
    ], dtype=float)

# -----------------------------
# Initial guess builder
# -----------------------------
def initial_guess():
    # Start with roughly even x spacing and a small downward sag
    x_lin = np.linspace(A[0], B[0], N+1)  # 5 nodes
    y_lin = np.linspace(A[1], B[1], N+1)
    # Add a gentle sag shape to interior nodes
    sag = 0.1 * L
    y_lin[1:-1] -= sag * ( (x_lin[1:-1] - A[0]) * (B[0] - x_lin[1:-1]) ) / (0.25*L*L + 1e-12)

    # Unknowns are r1,r2,r3 and T0..T3
    x1,y1 = x_lin[1], y_lin[1]
    x2,y2 = x_lin[2], y_lin[2]
    x3,y3 = x_lin[3], y_lin[3]

    # Reasonable initial tensions (horizontal-ish)
    T0 = T1 = T2 = T3 = 1.0
    return np.array([x1,y1,x2,y2,x3,y3, T0,T1,T2,T3], dtype=float)

# -----------------------------
# Solve
# -----------------------------
x0 = initial_guess()
sol, info = newton_solve(F, x0, J=None, tol=1e-10, max_iter=200, damping=True)

print("Success:", info["success"], "  iters:", info["iterations"], "  ||F||:", info["residual"])
(r0,r1,r2,r3,r4), T = unpack_vars(sol)
print("Nodes:")
print("r0 =", r0)
print("r1 =", r1)
print("r2 =", r2)
print("r3 =", r3)
print("r4 =", r4)
print("Tensions:", T)

# -----------------------------
# (Optional) plot the chain
# -----------------------------
try:
    import matplotlib.pyplot as plt
    X = [r0[0], r1[0], r2[0], r3[0], r4[0]]
    Y = [r0[1], r1[1], r2[1], r3[1], r4[1]]
    plt.figure()
    plt.plot(X, Y, marker='o')
    for i,(xi,yi) in enumerate(zip(X,Y)):
        plt.text(xi, yi, f"P{i}", ha='right', va='bottom')
    plt.axis('equal'); plt.grid(True)
    plt.title("Discrete Hanging Chain (4 links)")
    plt.xlabel("x"); plt.ylabel("y")
    plt.show()
except Exception as e:
    print("Plot skipped:", e)
